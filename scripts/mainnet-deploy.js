// Deploy the v1.3 OpenModelSettlement (v1.2 + per-batch inference stats) to
// Filecoin MAINNET, then bring it to parity with the live v1.2 instance.
//
// v1.3 versus v1.2: submitSettlement takes requestCounts/tokenCounts arrays (new
// selector, schema 3), SettlementRecord/SettlementExecuted carry requestCount and
// tokenCount, cumulativeRequests()/cumulativeTokens() expose all-time volume, and
// SCHEMA_VERSION() = 3 lets clients verify what they are talking to.
//
//   cd contracts
//   read -rs "K?cold key: " && export DEPLOYER_PRIVATE_KEY="0x${K#0x}" && unset K
//   npx hardhat run scripts/mainnet-deploy-v13.js --network mainnet
//
// FOUR STEPS, EACH IDEMPOTENT — every one re-reads chain state first, so a re-run
// after a timeout or an FEVM hash quirk resumes instead of repeating:
//   1. deploy(0 bps, 3600s)          — skipped if SETTLEMENT_ADDRESS is set
//   2. setEarningsFreeze(86400)      — skipped if already 86400
//   3. addSupportedToken(USDFC)      — skipped if already whitelisted
//   4. setOperator(hot key)          — skipped if already set
//
// If step 1 succeeds but a later step dies, re-run with SETTLEMENT_ADDRESS=0x... so
// the script continues on the SAME contract instead of deploying a second one.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PLATFORM_FEE_BPS = 0;      // trial parity with the live v1.2 instance
const REFUND_DELAY_SEC = 3600;
const EARNINGS_FREEZE_SEC = Number(process.env.EARNINGS_FREEZE_SEC || 86400); // 24h dispute window
const NATIVE = ethers.ZeroAddress;

// Normalize every address argument UP FRONT. A malformed one (a character dropped
// while copying, a bad checksum) otherwise surfaces only when its transaction is
// built — i.e. AFTER the deploy has already landed, leaving a half-configured
// contract. ethers treats an unparseable address as an ENS name and fails with an
// unrelated "resolveName is not implemented", which hides the real cause.
function addrArg(label, value) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address: ${JSON.stringify(value)}`);
  }
}
const USDFC = addrArg("USDFC", process.env.USDFC || "0x80B98d3aa09ffff255c3ba4A241111Ff1262F045");
// The hot settlement key that lives on the gateway server. It may ONLY settle.
const EXPECTED_OPERATOR = addrArg("EXPECTED_OPERATOR", process.env.EXPECTED_OPERATOR || "0x364960D9744364231c0c6577c7D75fB83C052735");
const GAS = { gasLimit: 60_000_000 }; // generous cap; unused gas is not charged

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR|actor not found|gas|too many requests|429/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const m = (e.shortMessage || e.message || "") + "";
      if (RETRYABLE.test(m) && i < 7) { console.log(`  (retry ${label} #${i + 1}: ${m.slice(0, 60)})`); await new Promise(r => setTimeout(r, 6000)); continue; }
      throw e;
    }
  }
  throw last;
}

// FEVM rewrites a broadcast tx's hash, and hardhat-ethers rejects the mismatch
// (BroadcastedTxDifferentHash) even though the tx mines fine. The v1.2 CALIBRATION
// drills already carried this recovery; the v1.3 calibration deploy did not, and
// aborted mid-run for exactly this reason. Never send a mainnet tx without it.
async function sendTx(label, send, verify) {
  try {
    const tx = await send();
    console.log(`  ${label} tx:`, tx.hash, "— waiting ...");
    const r = await tx.wait();
    console.log(`  ${label} confirmed in block`, r.blockNumber);
    return;
  } catch (e) {
    const msg = String(e);
    const quirk = /BroadcastedTxDifferentHash/.test(msg);
    if (!quirk) throw e;
    const real = (msg.match(/but got '(0x[0-9a-fA-F]{64})'/) || [])[1];
    console.log(`  (FEVM hash quirk on ${label}${real ? `; real hash ${real}` : ""} — polling chain state)`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      if (await verify()) { console.log(`  ${label} landed (confirmed by state read)`); return; }
      console.log(`  (still waiting on ${label} ... ${(i + 1) * 15}s)`);
    }
    throw new Error(`${label}: sent but not observed on chain after 300s — inspect before re-running`);
  }
}

async function main() {
  const provider = ethers.provider;
  // Signer comes from hardhat's network config (DEPLOYER_PRIVATE_KEY), never from
  // a local key file: a testnet key file carried over would silently make a
  // server-resident hot key the mainnet contract owner.
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set — hardhat has no signer for --network mainnet");
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no signer — set DEPLOYER_PRIVATE_KEY for --network mainnet");
  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314n) throw new Error(`wrong chain ${net.chainId} (want Filecoin mainnet 314)`);

  // The deployer BECOMES the owner (pause, fees, operator rotation, platform
  // withdrawals). That must stay the cold key, matching the live v1.2 instance.
  const EXPECTED_OWNER = addrArg("EXPECTED_OWNER", process.env.EXPECTED_OWNER || "0x3934Ab3DCb874e5dd33768C66f94aa0EcA83DF3b");
  if (deployer.address.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(`signer ${deployer.address} is not the expected cold owner ${EXPECTED_OWNER} — wrong key exported?`);
  }
  const bal = await withRetry(() => provider.getBalance(deployer.address), "bal");
  console.log("chainId:", net.chainId.toString());
  console.log("deployer (cold owner):", deployer.address, "| balance:", ethers.formatEther(bal), "FIL\n");
  if (bal < ethers.parseEther("0.5")) throw new Error("deployer balance below 0.5 FIL — top up before deploying");

  // ---- Step 1: deploy (or attach to an in-progress one) ----
  let c, addr, deployTx = process.env.DEPLOY_TX || "", deployBlock = 0;
  if (process.env.SETTLEMENT_ADDRESS) {
    addr = process.env.SETTLEMENT_ADDRESS;
    console.log("resuming on existing deployment:", addr);
    c = (await ethers.getContractAt("OpenModelSettlement", addr)).connect(deployer);
    const schema = await withRetry(() => c.SCHEMA_VERSION(), "schema");
    if (schema !== 3n) throw new Error(`SCHEMA_VERSION=${schema} at ${addr} — not a v1.3 contract`);
  } else {
    const S = await ethers.getContractFactory("OpenModelSettlement", deployer);
    console.log(`deploying v1.3 OpenModelSettlement(${PLATFORM_FEE_BPS} bps, ${REFUND_DELAY_SEC}s) ...`);
    try {
      c = await S.deploy(PLATFORM_FEE_BPS, REFUND_DELAY_SEC);
      await c.waitForDeployment();
      addr = await c.getAddress();
      const dtx = c.deploymentTransaction();
      deployTx = dtx.hash;
      const rcpt = await withRetry(() => provider.getTransactionReceipt(dtx.hash), "receipt");
      deployBlock = rcpt.blockNumber;
    } catch (e) {
      if (/BroadcastedTxDifferentHash/.test(String(e))) {
        const real = (String(e).match(/but got '(0x[0-9a-fA-F]{64})'/) || [])[1];
        throw new Error(
          "FEVM rewrote the deploy tx hash. The contract is most likely DEPLOYED — do NOT re-run blindly.\n" +
          `  Look up ${real || "the broadcast hash"} on https://filecoin.blockscout.com, take its created contract address,\n` +
          "  then re-run with SETTLEMENT_ADDRESS=0x<that address> to finish steps 2-4.");
      }
      throw e;
    }
    console.log("\nDEPLOYED:", addr);
    console.log("  tx:", deployTx, "| block:", deployBlock, "\n");
  }

  // ---- Step 2: earnings freeze ----
  const curFreeze = await withRetry(() => c.earningsFreezeSec(), "freeze");
  if (curFreeze === BigInt(EARNINGS_FREEZE_SEC)) {
    console.log(`earningsFreezeSec already ${EARNINGS_FREEZE_SEC} — skipping.`);
  } else {
    console.log(`setEarningsFreeze(${EARNINGS_FREEZE_SEC}) (current ${curFreeze}) ...`);
    await sendTx("setEarningsFreeze",
      () => c.setEarningsFreeze(EARNINGS_FREEZE_SEC, GAS),
      async () => (await c.earningsFreezeSec()) === BigInt(EARNINGS_FREEZE_SEC));
  }

  // ---- Step 3: USDFC whitelist ----
  if (await withRetry(() => c.supportedTokens(USDFC), "usdfc?")) {
    console.log("USDFC already whitelisted — skipping.");
  } else {
    console.log(`addSupportedToken(${USDFC}) ...`);
    await sendTx("addSupportedToken",
      () => c.addSupportedToken(USDFC, GAS),
      async () => await c.supportedTokens(USDFC));
  }

  // ---- Step 4: hand settlement to the hot operator key ----
  const curOp = await withRetry(() => c.operator(), "operator");
  if (curOp.toLowerCase() === EXPECTED_OPERATOR.toLowerCase()) {
    console.log("operator already set — skipping.");
  } else {
    console.log(`setOperator(${EXPECTED_OPERATOR}) (current ${curOp}) ...`);
    await sendTx("setOperator",
      () => c.setOperator(EXPECTED_OPERATOR, GAS),
      async () => (await c.operator()).toLowerCase() === EXPECTED_OPERATOR.toLowerCase());
  }

  // ---- Surface check ----
  console.log("\n--- surface check ---");
  let bad = 0;
  const chk = (n, cond, v) => { console.log((cond ? "OK   " : "BAD  ") + n + " = " + v); if (!cond) bad++; };
  const [owner, operator, arbiter, freeze, paused, fee, refund, schema, nativeOK, usdfcOK, cumReq, cumTok, nonce] =
    await Promise.all([c.owner(), c.operator(), c.arbiter(), c.earningsFreezeSec(), c.paused(),
      c.platformFeeBps(), c.refundDelaySec(), c.SCHEMA_VERSION(), c.supportedTokens(NATIVE),
      c.supportedTokens(USDFC), c.cumulativeRequests(), c.cumulativeTokens(), c.settlementNonce()]);
  chk("owner (cold)", owner.toLowerCase() === EXPECTED_OWNER.toLowerCase(), owner);
  chk("operator (hot)", operator.toLowerCase() === EXPECTED_OPERATOR.toLowerCase(), operator);
  chk("arbiter", arbiter.toLowerCase() === EXPECTED_OWNER.toLowerCase(), arbiter);
  chk("earningsFreezeSec", freeze === BigInt(EARNINGS_FREEZE_SEC), freeze);
  chk("paused", paused === false, paused);
  chk("platformFeeBps", fee === BigInt(PLATFORM_FEE_BPS), fee);
  chk("refundDelaySec", refund === BigInt(REFUND_DELAY_SEC), refund);
  chk("SCHEMA_VERSION", schema === 3n, schema);
  chk("FIL supported", nativeOK === true, nativeOK);
  chk("USDFC supported", usdfcOK === true, usdfcOK);
  chk("cumulativeRequests", cumReq === 0n, cumReq);
  chk("cumulativeTokens", cumTok === 0n, cumTok);
  chk("settlementNonce", nonce === 0n, nonce);
  if (bad) throw new Error(`${bad} surface check(s) failed — do NOT point the gateway at this contract yet`);

  const record = {
    network: "mainnet", chainId: 314, contract: "OpenModelSettlement", version: "v1.3-batch-stats",
    address: addr, deployer: deployer.address, owner, operator, arbiter,
    platformFeeBps: Number(fee), refundDelaySec: Number(refund), earningsFreezeSec: Number(freeze),
    stablecoins: [USDFC], contractSchema: 3,
    deployTx, blockNumber: deployBlock,
    deployedAt: new Date().toISOString(),
    supersedes: "0x465d979675d401295C529e15dC9187c9b92ed4d1",
    note: "v1.3 adds per-batch requestCount/tokenCount + cumulative counters; gateway must run contract_schema: 3",
  };
  // Staging record only — mainnet-finish.js is what (re)writes the canonical
  // deployments/mainnet.json after roles are set and verified.
  const out = path.join(__dirname, "..", "deployments", "mainnet-v13.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log("\nwrote", out);
  console.log("\nALL CHECKS PASSED. Next:");
  console.log("  1. verify the source:  npx hardhat verify --network mainnet " + addr + " 0 3600");
  console.log("  2. point the gateway at it (contract_address + contract_schema: 3) and restart");
  console.log("  3. deposit into the NEW contract — balances do not carry over from v1.2");
}

main().catch((e) => { console.error(e); process.exit(1); });
