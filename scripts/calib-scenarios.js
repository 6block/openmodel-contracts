// Broad on-chain test of OpenModelSettlement against a REAL chain (Calibration FEVM).
// Unlike the local Hardhat run, every tx is mined on real ~30s epochs, so this
// exercises real confirm timing, real gas, and real nonce ordering. Run with:
//   DEPLOYER_PRIVATE_KEY=<operator key> npx hardhat run scripts/calib-scenarios.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");

const ZERO = ethers.ZeroAddress;
const eth = (n) => ethers.parseEther(n);
const u6 = (n) => ethers.parseUnits(n, 6);
const fmt = (x) => ethers.formatEther(x);
const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REFUND_DELAY = 180; // seconds — short so the real-time timelock wait is bearable

let pass = 0, fail = 0;
function ok(name, cond, detail) { console.log((cond ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : "")); cond ? pass++ : fail++; }
async function expectRevert(name, p, frag) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); ok(name, false, "NO revert"); }
  catch (e) { const m = (e.shortMessage || e.reason || e.message || ""); ok(name, frag ? m.includes(frag) : true, "revert"); }
}
async function send(p) { const tx = await p; return await tx.wait(); } // wait for real confirmation

async function main() {
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const op = new ethers.Wallet(keys.operator, provider);   // operator/owner, read from file (no env key)
  const user = new ethers.Wallet(keys.user, provider);     // funded distinct user
  const user2 = ethers.Wallet.createRandom().address;      // zero-balance addr (insufficient-balance case)
  const sp1 = op.address;                                   // operator doubles as an SP (so we can withdraw)
  const sp2 = ethers.Wallet.createRandom().address;        // a second SP (receives only)

  console.log("operator:", op.address, "bal:", fmt(await provider.getBalance(op.address)), "tFIL");
  console.log("user:    ", user.address, "bal:", fmt(await provider.getBalance(user.address)), "tFIL");
  console.log("chainId:", (await provider.getNetwork()).chainId.toString(), "| refundDelay:", REFUND_DELAY, "s\n");

  // ---- deploy ----
  console.log(">> deploying (real confirms, be patient)...");
  const S = await ethers.getContractFactory("OpenModelSettlement", op);
  const c = await S.deploy(500, REFUND_DELAY); await c.waitForDeployment();
  const cAddr = await c.getAddress();
  const M = await ethers.getContractFactory("MockERC20", op);
  const usdc = await M.deploy("USD Coin", "USDC", 6); await usdc.waitForDeployment(); const U = await usdc.getAddress();
  const F = await ethers.getContractFactory("FeeOnTransferToken", op);
  const fee = await F.deploy(); await fee.waitForDeployment(); const FE = await fee.getAddress();
  console.log("settlement:", cAddr, "\nusdc:", U, "\nfeeToken:", FE, "\n");
  await send(c.addSupportedToken(U));
  await send(c.addSupportedToken(FE));

  const cu = c.connect(user);

  // ---- deposits ----
  await send(cu.depositFIL({ value: eth("5") }));
  ok("depositFIL credits 5 tFIL", (await c.getUserBalance(user.address, ZERO)) === eth("5"));

  await send(usdc.mint(user.address, u6("1000")));
  await send(usdc.connect(user).approve(cAddr, u6("200")));
  await send(cu.depositToken(U, u6("200")));
  ok("depositToken USDC credits 200", (await c.getUserBalance(user.address, U)) === u6("200"));

  await send(fee.mint(user.address, eth("100")));
  await send(fee.connect(user).approve(cAddr, eth("50")));
  const fb = await c.getUserBalance(user.address, FE);
  await send(cu.depositToken(FE, eth("50")));
  const credited = (await c.getUserBalance(user.address, FE)) - fb;
  ok("depositToken fee-on-transfer credits ACTUAL (45 of 50)", credited === eth("45"), "credited=" + fmt(credited));

  await expectRevert("depositToken non-whitelisted reverts", cu.depositToken(user.address, 1), "token not supported");

  // ---- refund lock semantics + front-running ----
  const balB = await c.getUserBalance(user.address, ZERO);
  await send(cu.requestRefund(ZERO, eth("4")));
  const rid = await c.refundNonce();
  ok("requestRefund does NOT deduct balance", (await c.getUserBalance(user.address, ZERO)) === balB);
  ok("requestRefund locks 4", (await c.lockedForRefund(user.address, ZERO)) === eth("4"));
  await expectRevert("requestRefund > free balance reverts", cu.requestRefund(ZERO, eth("100")), "insufficient free balance");

  // settlement draws full balance despite pending refund (anti front-running)
  await send(c.submitSettlement([user.address], [sp1], [eth("3")], [ZERO], kc("calib-b1")));
  ok("settlement drew despite pending refund (5->2)", (await c.getUserBalance(user.address, ZERO)) === eth("2"), "bal=" + fmt(await c.getUserBalance(user.address, ZERO)));
  ok("SP earnings 95% (3*0.95=2.85)", (await c.getSPEarnings(sp1, ZERO)) === eth("2.85"));

  await expectRevert("claimRefund too early reverts", cu.claimRefund(rid), "too early");

  // ---- partial-fail + zero-addr skip + dedup (one batch) ----
  await send(c.submitSettlement(
    [user.address, user2, user.address],
    [sp1, sp1, ZERO],
    [eth("1"), eth("1"), eth("1")],
    [ZERO, ZERO, ZERO], kc("calib-b2")));
  const rec = await c.getSettlement(await c.settlementNonce());
  ok("partial: settled=1 failed=2 (zero-bal user + zero-addr SP skipped)", rec.settledCount === 1n && rec.failedCount === 2n, "settled=" + rec.settledCount + " failed=" + rec.failedCount);
  await expectRevert("duplicate detailsHash reverts (no double charge)", c.submitSettlement([user.address], [sp1], [eth("0.1")], [ZERO], kc("calib-b2")), "batch already processed");

  // ---- setRefundDelay bound + platform fee ----
  await expectRevert("setRefundDelay > 30d reverts", c.setRefundDelay(31 * 24 * 3600), "refund delay too long");
  await send(c.setPlatformFee(300));
  ok("setPlatformFee -> 300bps", (await c.platformFeeBps()) === 300n);

  // ---- real-time refund timelock: wait out REFUND_DELAY then claim ----
  console.log(`>> waiting ${REFUND_DELAY + 20}s for refund timelock (real block time)...`);
  await sleep((REFUND_DELAY + 20) * 1000);
  // user balance is now 1 (5 -1(b1 took 3 ->2) -1(b2 took1 ->1)); the 4-locked refund can't fully claim
  await expectRevert("claim after delay but balance settled below locked -> reverts", cu.claimRefund(rid), "balance already settled");
  await send(cu.cancelRefund(rid));
  ok("cancelRefund releases lock", (await c.lockedForRefund(user.address, ZERO)) === 0n);

  // clean refund: request what's left, wait, claim succeeds
  const left = await c.getUserBalance(user.address, ZERO);
  await send(cu.requestRefund(ZERO, left));
  const rid2 = await c.refundNonce();
  console.log(`>> waiting ${REFUND_DELAY + 20}s for second timelock...`);
  await sleep((REFUND_DELAY + 20) * 1000);
  const before = await provider.getBalance(user.address);
  await send(cu.claimRefund(rid2));
  ok("claimRefund after delay succeeds (on-chain balance zeroed)", (await c.getUserBalance(user.address, ZERO)) === 0n);

  // ---- withdrawals ----
  const se = await c.getSPEarnings(sp1, ZERO);
  await send(c.connect(op).withdrawEarnings(ZERO));
  ok("SP withdrawEarnings zeroes earnings (had " + fmt(se) + ")", (await c.getSPEarnings(sp1, ZERO)) === 0n && se > 0n);
  const pe = await c.platformEarnings(ZERO);
  await send(c.withdrawPlatformEarnings(ZERO, op.address));
  ok("platform withdraw zeroes earnings (had " + fmt(pe) + ")", (await c.platformEarnings(ZERO)) === 0n && pe > 0n);

  console.log("\n==== Calibration on-chain scenarios: PASS=" + pass + " FAIL=" + fail + " ====");
  console.log("contract:", cAddr);
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
