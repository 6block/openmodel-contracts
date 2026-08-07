// Retrieve remaining funds from the RETIRED mainnet trial contract (v1.0).
// The gateway now settles against the v1.2 contract; nothing draws from the old
// one anymore, so the full balance breakdown is static and safe to withdraw.
//
// Three read-then-act modes (ACTION env, default "status"):
//   status  — read-only: balances / spEarnings / lockedForRefund / pending requests
//   exit    — withdrawEarnings(FIL) if any, then requestRefund(FIL, free balance);
//             prints the requestId + when it becomes claimable (refundDelay 3600s)
//   claim   — CLAIM_ID=<n> claimRefund(n) once the timelock has passed
//
// IDEMPOTENT: every tx is pre-checked against fresh on-chain state, so a re-run
// after a timeout can never double-send (earnings zero out; a landed refund
// request locks the balance, making free = 0).
//
// FALSE-ZERO GUARD: some Filecoin RPC endpoints intermittently answer eth_call
// with an empty body, which decodes as a perfectly plausible zero balance. A zero
// would make this script skip the withdrawal and report "nothing left" — the one
// failure mode that silently strands funds. So every zero is re-read against a
// second, independent endpoint before it is believed.
//
//   cd contracts
//   export DEPLOYER_PRIVATE_KEY=0x<wallet key>   # the wallet that holds the funds
//   ACTION=status npx hardhat run scripts/old-contract-exit.js --network mainnet
const { ethers } = require("hardhat");

const OLD_CONTRACT = process.env.OLD_CONTRACT || "0x1BB694BD2759eC88Bc04595D9677cb1065fa7D1f";
// Independent endpoints used only to confirm zero readings (see FALSE-ZERO GUARD).
// Comma-separated; tried in order until one answers, so a single dead endpoint
// cannot block the withdrawal.
const CROSS_RPC_URLS = (process.env.CROSS_RPC_URL ||
  "https://filecoin.drpc.org,https://api.chain.love/rpc/v1,https://api.node.glif.io/rpc/v1")
  .split(",").map((u) => u.trim()).filter(Boolean);
// The only wallet that ever held funds on the trial contract. Guard against
// accidentally running with some other key exported in the shell.
const EXPECTED_WALLET = process.env.EXPECTED_WALLET || "0x3934Ab3DCb874e5dd33768C66f94aa0EcA83DF3b";
const NATIVE = ethers.ZeroAddress;
const GAS_LIMIT = 60000000n; // generous cap, skips the flaky FEVM eth_estimateGas; unused gas is not charged

const ABI = [
  "function balances(address user, address token) view returns (uint256)",
  "function spEarnings(address sp, address token) view returns (uint256)",
  "function lockedForRefund(address user, address token) view returns (uint256)",
  "function refundRequests(uint256 id) view returns (address user, address token, uint256 amount, uint256 claimableAt, bool claimed, bool cancelled)",
  "function refundDelaySec() view returns (uint256)",
  "function paused() view returns (bool)",
  "function withdrawEarnings(address token)",
  "function requestRefund(address token, uint256 amount) returns (uint256)",
  "function claimRefund(uint256 requestId)",
  "event RefundRequested(uint256 indexed requestId, address indexed user, address indexed token, uint256 amount, uint256 claimableAt)",
];

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR|failed to estimate gas|message execution failed|too many requests|429/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 15; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const m = (e.shortMessage || e.message || e.info?.error?.message || "") + "";
      if (RETRYABLE.test(m) && i < 14) { console.log(`  (retry ${label} #${i + 1}: ${m.slice(0, 60)})`); await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e;
    }
  }
  throw last;
}

const fmt = (v) => ethers.formatEther(v) + " FIL";

// Re-read a zero against an independent endpoint. Returns the confirmed value, or
// throws if no endpoint could confirm it — refusing to act on an unverified zero is
// the whole point: a wrong zero here means walking away from the funds.
async function confirmZero(label, call) {
  const errors = [];
  for (const url of CROSS_RPC_URLS) {
    const p = new ethers.JsonRpcProvider(url);
    try {
      const v = await call(p);
      if (v !== 0n) {
        throw new Error(
          `${label}: primary RPC says 0 but ${url} says ${fmt(v)} — the primary endpoint is ` +
          `returning false zeros. Re-run with MAINNET_RPC_URL=${url} before touching anything.`);
      }
      console.log(`  (zero ${label} confirmed against ${url})`);
      return true;
    } catch (e) {
      if (/false zeros/.test(e.message)) throw e; // a real disagreement, not an endpoint failure
      errors.push(`${url}: ${(e.shortMessage || e.message || "").slice(0, 60)}`);
    } finally {
      p.destroy?.();
    }
  }
  throw new Error(
    `${label} read as 0 but no independent endpoint could confirm it, so the zero is not ` +
    `trustworthy. Tried:\n    ${errors.join("\n    ")}\n  Set CROSS_RPC_URL=<a working endpoint> and re-run.`);
}

async function main() {
  const action = (process.env.ACTION || "status").toLowerCase();
  const provider = ethers.provider;
  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314n) throw new Error(`refusing to run: chainId ${net.chainId} is not Filecoin mainnet (314)`);

  const code = await withRetry(() => provider.getCode(OLD_CONTRACT), "code");
  if (code === "0x") throw new Error(`no contract code at ${OLD_CONTRACT} — wrong address?`);

  // status is read-only and works without any key; exit/claim need the fund
  // holder's signature.
  const signers = await ethers.getSigners();
  const signer = signers[0] || null;
  if (signer && signer.address.toLowerCase() !== EXPECTED_WALLET.toLowerCase())
    throw new Error(`signer ${signer.address} is not the expected fund holder ${EXPECTED_WALLET} — wrong key exported?`);
  if (!signer && action !== "status")
    throw new Error(`ACTION=${action} needs the wallet key — export DEPLOYER_PRIVATE_KEY and re-run`);

  const c = new ethers.Contract(OLD_CONTRACT, ABI, signer || provider);
  const w = EXPECTED_WALLET;

  const read = async () => ({
    bal: await withRetry(() => c.balances(w, NATIVE), "balances"),
    earn: await withRetry(() => c.spEarnings(w, NATIVE), "spEarnings"),
    locked: await withRetry(() => c.lockedForRefund(w, NATIVE), "locked"),
    walletFil: await withRetry(() => provider.getBalance(w), "walletFil"),
  });
  let s = await read();
  const free = s.bal - s.locked;
  console.log("old contract:", OLD_CONTRACT);
  console.log("wallet:      ", w, "(on-chain FIL:", fmt(s.walletFil) + ")");
  console.log("  deposit balance:", fmt(s.bal), "| locked for refund:", fmt(s.locked), "| free:", fmt(free));
  console.log("  SP earnings:    ", fmt(s.earn));

  // A zero decides whether this script walks away from the money — never trust one
  // from a single endpoint.
  if (s.earn === 0n) {
    await confirmZero("SP earnings", (p) => new ethers.Contract(OLD_CONTRACT, ABI, p).spEarnings(w, NATIVE));
  }
  if (free === 0n) {
    await confirmZero("free deposit balance", async (p) => {
      const cc = new ethers.Contract(OLD_CONTRACT, ABI, p);
      return (await cc.balances(w, NATIVE)) - (await cc.lockedForRefund(w, NATIVE));
    });
  }

  // requestRefund is gated on the contract not being paused; withdrawEarnings is not.
  // Report it rather than guessing which call will revert.
  let isPaused = null;
  try { isPaused = await withRetry(() => c.paused(), "paused"); } catch { /* pre-pause build */ }
  if (isPaused === true) {
    console.log("  WARNING: contract is PAUSED — withdrawEarnings should still work, requestRefund will revert.");
  }
  console.log("");

  if (action === "status") {
    console.log("read-only mode. Next: ACTION=exit to withdraw earnings + request the refund.");
    return;
  }

  if (action === "exit") {
    // 1) SP earnings — instant transfer, no timelock.
    if (s.earn > 0n) {
      console.log(`withdrawEarnings(FIL) -> ${fmt(s.earn)} ...`);
      const tx = await c.withdrawEarnings(NATIVE, { gasLimit: GAS_LIMIT });
      console.log("  tx:", tx.hash, "— waiting ...");
      const r = await withRetry(() => tx.wait(), "withdrawEarnings wait");
      console.log("  confirmed in block", r.blockNumber, "\n");
    } else {
      console.log("SP earnings already zero — skipping withdrawEarnings.\n");
    }
    // 2) Deposit balance — timelocked refund request.
    if (free > 0n) {
      console.log(`requestRefund(FIL, ${fmt(free)}) ...`);
      const tx = await c.requestRefund(NATIVE, free, { gasLimit: GAS_LIMIT });
      console.log("  tx:", tx.hash, "— waiting ...");
      const r = await withRetry(() => tx.wait(), "requestRefund wait");
      const ev = r.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "RefundRequested");
      if (!ev) throw new Error("tx confirmed but RefundRequested event not found — inspect the tx before claiming");
      const id = ev.args.requestId;
      const at = new Date(Number(ev.args.claimableAt) * 1000);
      console.log("  confirmed in block", r.blockNumber);
      console.log(`  requestId = ${id} | claimable after ${at.toISOString()}`);
      console.log(`\nafter that time: ACTION=claim CLAIM_ID=${id} npx hardhat run scripts/old-contract-exit.js --network mainnet`);
    } else if (s.locked > 0n) {
      console.log("balance already locked by a pending refund request — nothing new to request.");
      console.log("(find your requestId in the earlier exit output, then run ACTION=claim)");
    } else {
      console.log("deposit balance is zero — nothing to refund.");
    }
    return;
  }

  if (action === "claim") {
    const id = BigInt(process.env.CLAIM_ID || "0");
    if (id === 0n) throw new Error("set CLAIM_ID=<requestId from the exit step>");
    const req = await withRetry(() => c.refundRequests(id), "refundRequests");
    if (req.user.toLowerCase() !== w.toLowerCase()) throw new Error(`request ${id} belongs to ${req.user}, not this wallet`);
    if (req.claimed) { console.log(`request ${id} already claimed — nothing to do.`); return; }
    if (req.cancelled) throw new Error(`request ${id} was cancelled`);
    const now = Math.floor(Date.now() / 1000);
    if (now < Number(req.claimableAt))
      throw new Error(`too early: claimable after ${new Date(Number(req.claimableAt) * 1000).toISOString()} (${Number(req.claimableAt) - now}s left)`);
    console.log(`claimRefund(${id}) -> ${fmt(req.amount)} ...`);
    const tx = await c.claimRefund(id, { gasLimit: GAS_LIMIT });
    console.log("  tx:", tx.hash, "— waiting ...");
    const r = await withRetry(() => tx.wait(), "claimRefund wait");
    console.log("  confirmed in block", r.blockNumber);
    s = await read();
    console.log("\nfinal state — deposit balance:", fmt(s.bal), "| SP earnings:", fmt(s.earn), "| wallet FIL:", fmt(s.walletFil));
    return;
  }

  throw new Error(`unknown ACTION "${action}" — use status | exit | claim`);
}

main().catch((e) => { console.error(e); process.exit(1); });
