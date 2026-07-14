// On-chain test (Calibration FEVM) of the two new contract features:
//   1) settler/owner separation (operator role)
//   2) emergency pause (halts deposit+settlement, refunds/withdrawals stay open)
// Deploys a fresh updated contract and drives real txs. Retries transient GLIF/RPC
// network blips (but never retries a real revert). Run with:
//   npx hardhat run scripts/calib-newfeatures.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");

const ZERO = ethers.ZeroAddress;
const eth = (n) => ethers.parseEther(n);
const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
let pass = 0, fail = 0;
function ok(name, cond, d) { console.log((cond ? "PASS" : "FAIL") + " | " + name + (d ? " | " + d : "")); cond ? pass++ : fail++; }

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR/i;
const REVERTY = /revert|not operator|not owner|paused|invalid|insufficient|already|too early|not your/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const m = (e.shortMessage || e.message || "") + "";
      if (REVERTY.test(m)) throw e;                    // a real revert: bubble up now
      if (RETRYABLE.test(m) && i < 5) { console.log("  (retry " + label + " #" + (i + 1) + ": " + m.slice(0, 45) + ")"); await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e;
    }
  }
  throw last;
}
const send = (thunk) => withRetry(async () => { const tx = await thunk(); return await tx.wait(); }, "send");
const rd = (thunk) => withRetry(thunk, "read");
async function expectRevert(name, thunk, frag) {
  try { await withRetry(async () => { const tx = await thunk(); if (tx && tx.wait) await tx.wait(); }, "expectRevert"); ok(name, false, "NO revert"); }
  catch (e) { const m = (e.shortMessage || e.reason || e.message || ""); ok(name, frag ? m.includes(frag) : true, m.slice(0, 50)); }
}

async function main() {
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const op = new ethers.Wallet(keys.operator, provider);  // owner + initial operator + an SP
  const user = new ethers.Wallet(keys.user, provider);    // depositor + stand-in "new operator"
  console.log("owner/op:", op.address, "| user:", user.address);
  console.log("chainId:", (await rd(() => provider.getNetwork())).chainId.toString());

  console.log(">> deploying updated contract (real ~30s confirms, be patient)...");
  const S = await ethers.getContractFactory("OpenModelSettlement", op);
  const c = await withRetry(async () => { const x = await S.deploy(500, 180); await x.waitForDeployment(); return x; }, "deploy");
  console.log("settlement:", await c.getAddress(), "\n");

  // ---------- 1) operator role ----------
  ok("operator defaults to deployer", (await rd(() => c.operator())).toLowerCase() === op.address.toLowerCase());
  await send(() => c.connect(user).depositFIL({ value: eth("0.5") }));
  ok("user deposited 0.5 tFIL", (await rd(() => c.getUserBalance(user.address, ZERO))) === eth("0.5"));

  await send(() => c.setOperator(user.address)); // hand settlement to the user key
  ok("operator rotated to user", (await rd(() => c.operator())).toLowerCase() === user.address.toLowerCase());

  const h1 = kc("byOperator");
  await expectRevert("owner (no longer operator) CANNOT settle",
    () => c.connect(op).submitSettlement([user.address], [op.address], [eth("0.1")], [ZERO], h1), "not operator");
  await send(() => c.connect(user).submitSettlement([user.address], [op.address], [eth("0.1")], [ZERO], h1));
  ok("designated operator settled on-chain", (await rd(() => c.getUserBalance(user.address, ZERO))) === eth("0.4"));
  await send(() => c.setPlatformFee(300)); // owner keeps admin despite giving up settling
  ok("owner still holds admin (setPlatformFee)", Number(await rd(() => c.platformFeeBps())) === 300);

  // ---------- 2) emergency pause ----------
  await send(() => c.pause());
  ok("paused == true", (await rd(() => c.paused())) === true);
  await expectRevert("deposit blocked while paused",
    () => c.connect(user).depositFIL({ value: eth("0.1") }), "paused");
  await expectRevert("settlement blocked while paused",
    () => c.connect(user).submitSettlement([user.address], [op.address], [eth("0.1")], [ZERO], kc("whilePaused")), "paused");
  // exits stay OPEN while paused (no fund trapping):
  await send(() => c.connect(user).requestRefund(ZERO, eth("0.2")));
  ok("refund request OPEN while paused", true);
  await send(() => c.connect(op).withdrawEarnings(ZERO)); // op earned as SP from the settle above
  ok("SP withdraw OPEN while paused", true);

  await send(() => c.unpause());
  ok("unpaused", (await rd(() => c.paused())) === false);
  await send(() => c.connect(user).depositFIL({ value: eth("0.05") }));
  ok("deposit works after unpause", true);

  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
