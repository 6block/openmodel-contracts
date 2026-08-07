// Mainnet deposit: fund your prepaid balance in the OpenModelSettlement contract
// (the balance API billing draws down). This MOVES REAL MAINNET FIL — run it yourself.
// The private key is read from the environment only; this script never writes it anywhere.
//
//   cd contracts
//   export DEPOSITOR_PRIVATE_KEY=0x<depositing wallet's private key>
//   export DEPOSIT_FIL=1                            # amount in FIL (default 1)
//   # optional: export MAINNET_RPC_URL=https://rpc.ankr.com/filecoin
//   npx hardhat run scripts/mainnet-deposit.js --network mainnet
//
// The contract address is read from deployments/mainnet.json. The script prints your
// in-contract balance before and after, so the credit is easy to verify.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const NATIVE = ethers.ZeroAddress;
const DEPOSIT_GAS_LIMIT = 60000000n; // explicit gasLimit skips the occasionally flaky eth_estimateGas

// Some public RPCs intermittently return empty eth_call bodies (which would read as a
// zero balance), so balance reads cross-check multiple endpoints and take the best answer.
const READ_RPCS = ["https://rpc.ankr.com/filecoin", "https://api.node.glif.io/rpc/v1"];
const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR|actor not found|failed to estimate gas|failed to apply on state|too many requests|429/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 12; i++) {
    try { return await fn(); }
    catch (e) { last = e; const m = (e.shortMessage || e.message || "") + ""; if (RETRYABLE.test(m) && i < 11) { console.log(`  (retry ${label} #${i + 1})`); await new Promise(r => setTimeout(r, 4000)); continue; } throw e; }
  }
  throw last;
}

// Read a user's in-contract FIL balance across endpoints; take the maximum (dodges false zeros).
async function readUserBalance(addr, user, abi) {
  let best = 0n;
  for (const url of READ_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      const c = new ethers.Contract(addr, abi, p);
      const b = await withRetry(() => c.getUserBalance(user, NATIVE), "getUserBalance");
      if (b > best) best = b;
    } catch { }
  }
  return best;
}

async function main() {
  // CONTRACT wins over the deployment record. During a contract migration the
  // record still names the OUTGOING instance for a while, and depositing into a
  // retired contract strands the funds there (they are recoverable, but only via
  // the refund timelock). Always pass CONTRACT explicitly around a migration.
  let addr, src;
  if (process.env.CONTRACT) {
    try {
      addr = ethers.getAddress(process.env.CONTRACT);
    } catch {
      throw new Error(`CONTRACT is not a valid address: ${JSON.stringify(process.env.CONTRACT)}`);
    }
    src = "CONTRACT env var";
  } else {
    const rec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "mainnet.json"), "utf8"));
    addr = ethers.getAddress(rec.address);
    src = "deployments/mainnet.json (" + (rec.version || "unversioned") + ")";
  }
  const amount = process.env.DEPOSIT_FIL || "1";
  const art = require("../artifacts/contracts/OpenModelSettlement.sol/OpenModelSettlement.json");

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("export DEPOSITOR_PRIVATE_KEY (the depositing wallet's key) first");
  const provider = ethers.provider;
  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314n) throw new Error(`refusing to run: chainId ${net.chainId} is not Filecoin mainnet (314)`);

  const walletBal = await withRetry(() => provider.getBalance(signer.address), "wallet-bal");
  console.log("contract:", addr, "[from " + src + "]");
  // Depositing into a contract with no code would burn the funds outright.
  if ((await withRetry(() => provider.getCode(addr), "code")) === "0x") {
    throw new Error(`no contract code at ${addr} — wrong address`);
  }
  console.log("depositing wallet:", signer.address, "| on-chain balance:", ethers.formatEther(walletBal), "FIL");
  const before = await readUserBalance(addr, signer.address, art.abi);
  console.log("in-contract balance before:", ethers.formatEther(before), "FIL");
  console.log(`\ndepositing ${amount} FIL via depositFIL() ...`);
  if (walletBal < ethers.parseEther(amount)) throw new Error("wallet balance too low for this deposit (gas must be left over too)");

  const c = new ethers.Contract(addr, art.abi, signer);
  const tx = await c.depositFIL({ value: ethers.parseEther(amount), gasLimit: DEPOSIT_GAS_LIMIT });
  console.log("  tx:", tx.hash, "— waiting for confirmation ...");
  const rcpt = await withRetry(() => tx.wait(), "deposit-wait");
  console.log("  confirmed in block", rcpt.blockNumber, "| gas used:", rcpt.gasUsed.toString());

  const after = await readUserBalance(addr, signer.address, art.abi);
  console.log("\nin-contract balance after:", ethers.formatEther(after), "FIL");
  const delta = after - before;
  console.log(delta === ethers.parseEther(amount)
    ? `✓ balance up exactly +${amount} FIL — deposit credited`
    : `note: balance delta ${ethers.formatEther(delta)} FIL (an endpoint may be lagging; re-check shortly)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
