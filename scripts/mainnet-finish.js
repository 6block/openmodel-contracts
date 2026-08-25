// Finish a mainnet deployment whose contract deployed OK but whose post-deploy
// setOperator did not land (FEVM gas estimation fails for a few seconds right after
// deploy, while the fresh contract propagates across the RPC load balancer).
//
// IDEMPOTENT and non-destructive:
//   - never deploys anything (attaches to the EXISTING address)
//   - verifies the on-chain trial surface (owner / fee=0 / refundDelay / native FIL)
//   - if operator is not yet the target, waits for the contract to be visible, then
//     sends setOperator with an explicit gas limit (bypassing the flaky estimator)
//   - re-verifies and (re)writes deployments/mainnet.json
//   - if operator is already the target, it just re-verifies + records (safe to re-run)
//
//   cd contracts
//   export DEPLOYER_PRIVATE_KEY=0x<owner private key>   # the OWNER account
//   export OPERATOR_ADDRESS=0x364960D9744364231c0c6577c7D75fB83C052735
//   # CONTRACT_ADDRESS defaults to the recorded mainnet.json address; override if needed
//   npx hardhat run scripts/mainnet-finish.js --network mainnet
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const RECORD = path.join(__dirname, "..", "deployments", "mainnet.json");
const NATIVE = ethers.ZeroAddress;
// setOperator is a single SSTORE + event; on FEVM that is a few M gas. This ceiling is
// generous and only caps the tx — unused gas is not charged — so it lets us skip the
// eth_estimateGas call that flakes right after deploy. Base fee on Filecoin is tiny, so
// the up-front reservation (gasLimit × maxFeePerGas) is a small fraction of a FIL.
const SET_OP_GAS_LIMIT = 60000000n;

// Filecoin's public RPC (glif) is a load balancer over many nodes; a lagging node can
// transiently fail even a plain eth_call getter with any of these before a healthy node
// answers on retry. All are node-state transients here (the getters cannot genuinely
// revert or run out of gas), so we retry hard rather than abort.
const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR|actor not found|failed to estimate gas|failed to apply on state|apply on state with gas|execution reverted.*\bnonce\b|message execution failed|lookback|load state|cannot find|not found in|too many requests|429/i;
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

async function main() {
  const addr = process.env.CONTRACT_ADDRESS ||
    (fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, "utf8")).address : "");
  if (!addr) throw new Error("set CONTRACT_ADDRESS (or have deployments/mainnet.json present)");
  const target = process.env.OPERATOR_ADDRESS || "";
  if (target && !ethers.isAddress(target)) throw new Error(`OPERATOR_ADDRESS invalid: ${target}`);

  const provider = ethers.provider;
  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314n) throw new Error(`refusing to run: chainId ${net.chainId} is not Filecoin mainnet (314)`);

  const art = require("../artifacts/contracts/OpenModelSettlement.sol/OpenModelSettlement.json");
  const readC = new ethers.Contract(addr, art.abi, provider);

  // Guard: the contract must actually exist at this address.
  const code = await withRetry(() => provider.getCode(addr), "code");
  if (code === "0x") throw new Error(`no contract code at ${addr} — wrong address?`);
  console.log("contract:", addr, `(code ${(code.length - 2) / 2} bytes)`);

  const read = async () => ({
    owner: await withRetry(() => readC.owner(), "owner"),
    operator: await withRetry(() => readC.operator(), "operator"),
    paused: await withRetry(() => readC.paused(), "paused"),
    fee: await withRetry(() => readC.platformFeeBps(), "fee"),
    rd: await withRetry(() => readC.refundDelaySec(), "rd"),
    nativeOK: await withRetry(() => readC.supportedTokens(NATIVE), "native"),
  });
  let s = await read();
  console.log("owner:", s.owner, "| operator:", s.operator, "| fee:", s.fee.toString(), "bps | refundDelay:", s.rd.toString(), "s | paused:", s.paused, "| native FIL:", s.nativeOK, "\n");

  // setOperator if needed and possible.
  if (target && s.operator.toLowerCase() !== target.toLowerCase()) {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    if (!owner) throw new Error("operator needs setting but no signer — export DEPLOYER_PRIVATE_KEY (owner key) and re-run");
    if (owner.address.toLowerCase() !== s.owner.toLowerCase())
      throw new Error(`signer ${owner.address} is not the contract owner ${s.owner} — only owner can setOperator`);
    const cw = new ethers.Contract(addr, art.abi, owner);
    // Send-with-recheck: before EVERY attempt, re-read operator — if a previous attempt's
    // tx actually landed (despite a thrown/timed-out response), we detect it and stop, so a
    // retry can never broadcast a second setOperator. Explicit gasLimit skips the flaky
    // eth_estimateGas entirely.
    let done = false;
    for (let attempt = 1; attempt <= 10 && !done; attempt++) {
      const cur = await withRetry(() => readC.operator(), "operator-precheck");
      if (cur.toLowerCase() === target.toLowerCase()) { console.log("  operator already set (a prior attempt landed).\n"); done = true; break; }
      try {
        console.log(`setOperator -> ${ethers.getAddress(target)} (attempt ${attempt}, gasLimit ${SET_OP_GAS_LIMIT}) ...`);
        const tx = await cw.setOperator(ethers.getAddress(target), { gasLimit: SET_OP_GAS_LIMIT });
        console.log("  tx:", tx.hash, "— waiting for confirmation ...");
        const rcpt = await withRetry(() => tx.wait(), "setOperator wait");
        console.log("  confirmed in block", rcpt.blockNumber, "| gas used:", rcpt.gasUsed.toString(), "\n");
        done = true;
      } catch (e) {
        const m = (e.shortMessage || e.message || e.info?.error?.message || "") + "";
        if (!RETRYABLE.test(m) || attempt === 10) throw e;
        console.log(`  (setOperator attempt ${attempt} transient: ${m.slice(0, 60)}; re-checking + retrying)`);
        await new Promise(r => setTimeout(r, 6000));
      }
    }
    s = await read();
  } else if (target) {
    console.log("operator already == target; nothing to do (idempotent re-run).\n");
  } else {
    console.log("OPERATOR_ADDRESS not set — leaving operator as owner.\n");
  }

  // Verify the final trial surface.
  let bad = 0;
  const chk = (n, cond, v) => { console.log((cond ? "OK  " : "BAD ") + n + " = " + v); if (!cond) bad++; };
  chk("paused == false", s.paused === false, s.paused);
  chk("platformFeeBps == 0", s.fee === 0n, s.fee.toString());
  chk("refundDelaySec == 3600", s.rd === 3600n, s.rd.toString());
  chk("native FIL supported", s.nativeOK === true, s.nativeOK);
  if (target) chk("operator == target", s.operator.toLowerCase() === target.toLowerCase(), s.operator);
  if (bad > 0) throw new Error(`${bad} check(s) failed — do NOT wire the gateway yet`);

  // Record final state (preserve deploy tx/block if already recorded).
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(RECORD, "utf8")); } catch { }
  const record = {
    network: "mainnet", chainId: 314, contract: "OpenModelSettlement",
    address: addr, deployer: prev.deployer || s.owner, owner: s.owner, operator: s.operator,
    platformFeeBps: Number(s.fee), refundDelaySec: Number(s.rd), stablecoins: [],
    deployTx: prev.deployTx || "", blockNumber: prev.blockNumber || 0,
    deployedAt: prev.deployedAt || new Date().toISOString(),
    operatorSetAt: (target && s.operator.toLowerCase() === target.toLowerCase()) ? new Date().toISOString() : (prev.operatorSetAt || null),
  };
  fs.writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n");
  console.log("\nrecorded to deployments/mainnet.json");
  console.log("next: in the openmodel-gateway repo, set settlement.contract_address in config/sp-state-agent-mainnet.yaml to", addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
