// Clean, PERMANENT deployment of the enhanced OpenModelSettlement (operator/owner
// separation + emergency pause) to Calibration FEVM, to become the LONG-TERM testnet
// contract and REPLACE the pre-enhancement 0xf1cDF4320952A60edeF3e70b5D1C136334cDE261.
//
// Unlike calib-newfeatures.js (which deploys a throwaway instance and DIRTIES its state
// by running the operator-rotation / pause / settlement test scenarios), this deploys
// ONE clean instance, verifies the initial state + enhanced surface, and RECORDS the
// address to deployments/calibration.json so it is not an orphan.
//
//   npx hardhat run scripts/calib-deploy-settlement.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PLATFORM_FEE_BPS = 500;   // 5% — matches the M3 local gateway; owner can setPlatformFee later
const REFUND_DELAY_SEC = 3600;  // 1 hour; owner can setRefundDelay later (bounded by MAX_REFUND_DELAY)
const NATIVE = ethers.ZeroAddress;
const OLD = "0xf1cDF4320952A60edeF3e70b5D1C136334cDE261"; // pre-enhancement, now deprecated

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const m = (e.shortMessage || e.message || "") + "";
      if (RETRYABLE.test(m) && i < 5) { console.log(`  (retry ${label} #${i + 1}: ${m.slice(0, 45)})`); await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e;
    }
  }
  throw last;
}

async function main() {
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const deployer = new ethers.Wallet(keys.operator, provider); // becomes owner + initial operator
  const net = await withRetry(() => provider.getNetwork(), "net");
  const bal = await withRetry(() => provider.getBalance(deployer.address), "bal");
  console.log("chainId:", net.chainId.toString());
  console.log("deployer:", deployer.address, "| balance:", ethers.formatEther(bal), "tFIL\n");

  const S = await ethers.getContractFactory("OpenModelSettlement", deployer);
  console.log(`deploying OpenModelSettlement(${PLATFORM_FEE_BPS} bps, ${REFUND_DELAY_SEC}s) ...`);
  const c = await withRetry(async () => { const x = await S.deploy(PLATFORM_FEE_BPS, REFUND_DELAY_SEC); await x.waitForDeployment(); return x; }, "deploy");
  const addr = await c.getAddress();
  const dtx = c.deploymentTransaction();
  const rcpt = await withRetry(() => provider.getTransactionReceipt(dtx.hash), "receipt");
  console.log("\nDEPLOYED:", addr);
  console.log("  tx:", dtx.hash, "| block:", rcpt.blockNumber, "\n");

  // Verify the enhanced surface + a clean initial state (no test dirt).
  const owner = await withRetry(() => c.owner(), "owner");
  const operator = await withRetry(() => c.operator(), "operator");
  const paused = await withRetry(() => c.paused(), "paused");
  const fee = await withRetry(() => c.platformFeeBps(), "fee");
  const rd = await withRetry(() => c.refundDelaySec(), "rd");
  const nativeOK = await withRetry(() => c.supportedTokens(NATIVE), "native");
  let bad = 0;
  const chk = (n, cond, v) => { console.log((cond ? "OK  " : "BAD ") + n + " = " + v); if (!cond) bad++; };
  chk("owner == deployer", owner.toLowerCase() === deployer.address.toLowerCase(), owner);
  chk("operator == deployer (clean initial)", operator.toLowerCase() === deployer.address.toLowerCase(), operator);
  chk("paused == false (clean)", paused === false, String(paused));
  chk("platformFeeBps == " + PLATFORM_FEE_BPS, Number(fee) === PLATFORM_FEE_BPS, fee.toString());
  chk("refundDelaySec == " + REFUND_DELAY_SEC, Number(rd) === REFUND_DELAY_SEC, rd.toString());
  chk("native FIL supported", nativeOK === true, String(nativeOK));

  // Record the deployment so it is tracked (the whole point vs the throwaway test script).
  const rec = {
    network: "calibration", chainId: Number(net.chainId),
    contract: "OpenModelSettlement",
    address: addr, deployer: deployer.address, owner, operator,
    platformFeeBps: PLATFORM_FEE_BPS, refundDelaySec: REFUND_DELAY_SEC,
    deployTx: dtx.hash, blockNumber: rcpt.blockNumber,
    deployedAt: new Date().toISOString(),
    supersedes: OLD,
    features: ["operator/owner separation", "emergency pause"],
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "calibration.json"), JSON.stringify(rec, null, 2) + "\n");
  console.log("\nrecorded -> contracts/deployments/calibration.json");

  if (bad > 0) { console.error(`\n${bad} verification check(s) FAILED`); process.exit(1); }
  console.log("\nall checks passed. Old contract " + OLD + " is now deprecated.");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
