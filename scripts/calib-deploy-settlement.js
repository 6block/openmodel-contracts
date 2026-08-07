// Deploy the v1.3 OpenModelSettlement (per-batch inference stats) to Calibration.
//
// v1.3 changes versus v1.2:
//   - submitSettlement takes requestCounts/tokenCounts arrays (schema 3, new selector)
//   - SettlementRecord/SettlementExecuted carry requestCount/tokenCount
//   - cumulativeRequests()/cumulativeTokens() global counters
//   - SCHEMA_VERSION() = 3 marker for client-side verification
//
// Parameters: fee 500 bps, refund delay 3600 s, earnings freeze 604800 s (set
// after deploy — the constructor starts it at 0).
//
//   npx hardhat run scripts/calib-deploy-v13.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PLATFORM_FEE_BPS = 500;
const REFUND_DELAY_SEC = 3600;
const EARNINGS_FREEZE_SEC = 604800; // 7d dispute window

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

async function main() {
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set — hardhat has no signer for --network calibration");
  }
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners(); // becomes owner + operator + arbiter
  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314159n) throw new Error(`wrong chain ${net.chainId} (want calibration 314159)`);
  const bal = await withRetry(() => provider.getBalance(deployer.address), "bal");
  console.log("chainId:", net.chainId.toString());
  console.log("deployer:", deployer.address, "| balance:", ethers.formatEther(bal), "tFIL\n");

  const S = await ethers.getContractFactory("OpenModelSettlement", deployer);
  console.log(`deploying v1.3 OpenModelSettlement(${PLATFORM_FEE_BPS} bps, ${REFUND_DELAY_SEC}s) ...`);
  const c = await withRetry(async () => { const x = await S.deploy(PLATFORM_FEE_BPS, REFUND_DELAY_SEC); await x.waitForDeployment(); return x; }, "deploy");
  const addr = await c.getAddress();
  const dtx = c.deploymentTransaction();
  const rcpt = await withRetry(() => provider.getTransactionReceipt(dtx.hash), "receipt");
  console.log("\nDEPLOYED:", addr);
  console.log("tx:", dtx.hash, "block:", rcpt.blockNumber);

  console.log(`\nsetEarningsFreeze(${EARNINGS_FREEZE_SEC}) ...`);
  await withRetry(async () => { const tx = await c.setEarningsFreeze(EARNINGS_FREEZE_SEC); await tx.wait(); }, "setEarningsFreeze");

  // Sanity: the schema marker and the fresh stats counters.
  const schema = await withRetry(() => c.SCHEMA_VERSION(), "schema");
  const cumReq = await withRetry(() => c.cumulativeRequests(), "cumReq");
  const cumTok = await withRetry(() => c.cumulativeTokens(), "cumTok");
  const freeze = await withRetry(() => c.earningsFreezeSec(), "freeze");
  console.log(`SCHEMA_VERSION=${schema} cumulativeRequests=${cumReq} cumulativeTokens=${cumTok} earningsFreezeSec=${freeze}`);
  if (schema !== 3n) throw new Error("SCHEMA_VERSION is not 3 — wrong artifact?");

  const record = {
    network: "calibration",
    chainId: 314159,
    version: "v1.3-batch-stats",
    address: addr,
    deployTx: dtx.hash,
    block: rcpt.blockNumber,
    platformFeeBps: PLATFORM_FEE_BPS,
    refundDelaySec: REFUND_DELAY_SEC,
    earningsFreezeSec: EARNINGS_FREEZE_SEC,
    owner: deployer.address,
    operator: deployer.address,
    arbiter: deployer.address,
    deployedAt: new Date().toISOString(),
    purpose: "v1.3 per-batch inference stats (requestCount/tokenCount + cumulative counters)",
    };
  const out = path.join(__dirname, "..", "deployments", "calibration-v13.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log("\nwrote", out);
  console.log("\nnext: point the gateway at this address with settlement.contract_schema: 3, then deposit test balance (calib-deposit.js CONTRACT=" + addr + ")");
}

main().catch((e) => { console.error(e); process.exit(1); });
