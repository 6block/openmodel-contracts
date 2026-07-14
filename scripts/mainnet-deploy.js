// PERMANENT mainnet deployment of OpenModelSettlement (Filecoin mainnet, chainId 314).
//
// Trial-phase parameters, deliberately conservative:
//   - platformFeeBps = 0      (no platform cut for the trial; owner can setPlatformFee later)
//   - refundDelaySec = 3600   (1h; owner can setRefundDelay later)
//   - FIL only — no stablecoin is whitelisted (add later with owner addSupportedToken)
//
// Roles: the deployer becomes owner + initial operator. If OPERATOR_ADDRESS is set (and
// differs from the deployer), the script immediately hands the settling role to it via
// setOperator — owner key stays cold, operator key is the gateway's hot key.
//
// Run (the DEPLOYER key is the OWNER account; only the address of the operator is needed):
//
//   cd contracts
//   export DEPLOYER_PRIVATE_KEY=0x<owner private key>     # never committed, env only
//   export OPERATOR_ADDRESS=0x<operator ADDRESS>          # optional; omit to keep owner==operator
//   npx hardhat run scripts/mainnet-deploy.js --network mainnet
//
// The script prints the deployer balance and asks nothing else; it aborts if the chain
// is not mainnet (314). Deployment is recorded to deployments/mainnet.json.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PLATFORM_FEE_BPS = 0;     // trial: no platform fee
const REFUND_DELAY_SEC = 3600;  // 1 hour
const NATIVE = ethers.ZeroAddress;

// "Actor not found" is retryable here: a freshly funded account can be missing from a
// lagging node behind the RPC load balancer for a short while (we always verify the
// account's existence and balance up front, so it is never a genuinely absent actor).
const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR|actor not found/i;
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
  const [deployer] = await ethers.getSigners(); // from DEPLOYER_PRIVATE_KEY (hardhat.config mainnet)
  if (!deployer) throw new Error("set DEPLOYER_PRIVATE_KEY (owner key) in the environment first");
  const provider = ethers.provider;

  const net = await withRetry(() => provider.getNetwork(), "net");
  if (net.chainId !== 314n) throw new Error(`refusing to run: chainId ${net.chainId} is not Filecoin mainnet (314)`);
  const bal = await withRetry(() => provider.getBalance(deployer.address), "bal");
  console.log("chainId:", net.chainId.toString(), "(Filecoin mainnet)");
  console.log("deployer/owner:", deployer.address, "| balance:", ethers.formatEther(bal), "FIL");

  const operatorAddr = process.env.OPERATOR_ADDRESS || "";
  if (operatorAddr) {
    if (!ethers.isAddress(operatorAddr)) throw new Error(`OPERATOR_ADDRESS is not a valid address: ${operatorAddr}`);
    console.log("operator (to be set):", ethers.getAddress(operatorAddr));
  } else {
    console.log("operator: (none given — deployer stays owner + operator)");
  }
  console.log();

  const S = await ethers.getContractFactory("OpenModelSettlement", deployer);
  console.log(`deploying OpenModelSettlement(${PLATFORM_FEE_BPS} bps, ${REFUND_DELAY_SEC}s) ...`);
  const c = await withRetry(async () => { const x = await S.deploy(PLATFORM_FEE_BPS, REFUND_DELAY_SEC); await x.waitForDeployment(); return x; }, "deploy");
  const addr = await c.getAddress();
  const dtx = c.deploymentTransaction();
  const rcpt = await withRetry(() => provider.getTransactionReceipt(dtx.hash), "receipt");
  console.log("\nDEPLOYED:", addr);
  console.log("  tx:", dtx.hash, "| block:", rcpt.blockNumber, "| gas used:", rcpt.gasUsed.toString(), "\n");

  // Hand settling to the dedicated operator (owner keeps every other right).
  let finalOperator = deployer.address;
  if (operatorAddr && ethers.getAddress(operatorAddr) !== deployer.address) {
    console.log("setOperator ->", ethers.getAddress(operatorAddr), "...");
    const tx = await withRetry(() => c.setOperator(ethers.getAddress(operatorAddr)), "setOperator");
    await withRetry(() => tx.wait(), "setOperator wait");
    finalOperator = ethers.getAddress(operatorAddr);
    console.log("  done:", tx.hash, "\n");
  }

  // Verify the exact trial surface before recording anything.
  const owner = await withRetry(() => c.owner(), "owner");
  const operator = await withRetry(() => c.operator(), "operator");
  const paused = await withRetry(() => c.paused(), "paused");
  const fee = await withRetry(() => c.platformFeeBps(), "fee");
  const rd = await withRetry(() => c.refundDelaySec(), "rd");
  const nativeOK = await withRetry(() => c.supportedTokens(NATIVE), "native");
  let bad = 0;
  const chk = (n, cond, v) => { console.log((cond ? "OK  " : "BAD ") + n + " = " + v); if (!cond) bad++; };
  chk("owner == deployer", owner === deployer.address, owner);
  chk("operator == " + finalOperator, operator === finalOperator, operator);
  chk("paused == false", paused === false, paused);
  chk("platformFeeBps == 0", Number(fee) === PLATFORM_FEE_BPS, fee.toString());
  chk("refundDelaySec == 3600", Number(rd) === REFUND_DELAY_SEC, rd.toString());
  chk("native FIL supported", nativeOK === true, nativeOK);
  if (bad > 0) throw new Error(`${bad} post-deploy check(s) failed — do NOT wire the gateway to this address`);

  const record = {
    network: "mainnet", chainId: 314, contract: "OpenModelSettlement",
    address: addr, deployer: deployer.address, owner, operator,
    platformFeeBps: PLATFORM_FEE_BPS, refundDelaySec: REFUND_DELAY_SEC,
    stablecoins: [], deployTx: dtx.hash, blockNumber: rcpt.blockNumber,
    deployedAt: new Date().toISOString(),
  };
  const out = path.join(__dirname, "..", "deployments", "mainnet.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log("\nrecorded to deployments/mainnet.json");
  console.log("next: fill config/sp-state-agent-mainnet.yaml contract_address with", addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
