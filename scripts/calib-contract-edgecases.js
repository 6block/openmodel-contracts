// Contract edge cases on Calibration (failure-mode gaps item #4):
//   A. Emergency PAUSE effect on the long-term contract 0x83c2… (non-dirtying: pause →
//      deposit & settlement revert "paused" → unpause; refund/withdraw-open-while-paused
//      is covered by identical-bytecode local/throwaway tests).
//   B. transferOwnership (change owner) on 0x83c2…: owner → user, old owner loses admin,
//      user transfers back — long-term contract left with original owner.
//   C. Large 100-item batch gas on a FRESH instance vs the block gas limit (does a full
//      MAX_BATCH_SIZE settlement fit in one FEVM block?).
//   npx hardhat run scripts/calib-contract-edgecases.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR/i;
const REVERTY = /revert|not operator|not owner|paused|invalid|insufficient|already|zero/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) { last = e; const m = (e.shortMessage || e.message || "") + "";
      if (REVERTY.test(m)) throw e;
      if (RETRYABLE.test(m) && i < 5) { console.log(`  (retry ${label} #${i + 1})`); await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e; } }
  throw last;
}
const send = (thunk) => withRetry(async () => { const tx = await thunk(); return await tx.wait(); }, "send");
const rd = (thunk) => withRetry(thunk, "read");
let bad = 0;
const chk = (n, c, d) => { console.log((c ? "OK   " : "BAD  ") + n + (d ? " | " + d : "")); if (!c) bad++; };
async function expectRevert(name, thunk, frag) {
  try { await withRetry(async () => { const tx = await thunk(); if (tx && tx.wait) await tx.wait(); }, "exp"); console.log("BAD  " + name + " | NO revert"); bad++; }
  catch (e) { const m = (e.shortMessage || e.reason || e.message || ""); const ok = m.includes(frag); console.log((ok ? "OK   " : "BAD  ") + name + " | " + m.slice(0, 45)); if (!ok) bad++; }
}

async function main() {
  const rec = JSON.parse(fs.readFileSync("deployments/calibration.json", "utf8"));
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const owner = new ethers.Wallet(keys.operator, provider); // owner + operator of 0x83c2…
  const user = new ethers.Wallet(keys.user, provider);      // non-owner
  const ZERO = ethers.ZeroAddress;
  const eth = (n) => ethers.parseEther(n);
  const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const c = await ethers.getContractAt("OpenModelSettlement", rec.address, owner);
  console.log("long-term contract:", rec.address, "\n");

  // ===== A. emergency pause EFFECT (non-dirtying) =====
  console.log("--- A. emergency pause effect (0x83c2…) ---");
  await send(() => c.pause());
  chk("paused == true", (await rd(() => c.paused())) === true);
  await expectRevert("deposit blocked while paused", () => c.connect(user).depositFIL({ value: eth("0.001") }), "paused");
  await expectRevert("settlement blocked while paused", () => c.submitSettlement([user.address], [owner.address], [eth("0.001")], [ZERO], kc("pausedprobe")), "paused");
  await send(() => c.unpause());
  chk("paused == false after unpause", (await rd(() => c.paused())) === false);

  // ===== B. transferOwnership (change owner), rotate + restore =====
  console.log("--- B. transferOwnership (0x83c2…) ---");
  chk("owner == deployer initially", (await rd(() => c.owner())).toLowerCase() === owner.address.toLowerCase());
  await send(() => c.transferOwnership(user.address));
  chk("owner changed -> user", (await rd(() => c.owner())).toLowerCase() === user.address.toLowerCase());
  await expectRevert("old owner loses admin (setPlatformFee)", () => c.connect(owner).setPlatformFee(400), "not owner");
  await send(() => c.connect(user).transferOwnership(owner.address)); // user (now owner) hands it back
  chk("owner restored -> deployer", (await rd(() => c.owner())).toLowerCase() === owner.address.toLowerCase());

  // ===== C. 100-item batch gas on a FRESH instance =====
  console.log("--- C. 100-item batch gas (fresh instance) ---");
  const S = await ethers.getContractFactory("OpenModelSettlement", owner);
  const fresh = await withRetry(async () => { const x = await S.deploy(500, 3600); await x.waitForDeployment(); return x; }, "deploy");
  const fAddr = await fresh.getAddress();
  console.log("fresh instance:", fAddr);
  await send(() => fresh.connect(user).depositFIL({ value: eth("1") })); // fund 1 user so item[0] settles
  const users = [user.address], sps = [owner.address], amts = [eth("0.001")], toks = [ZERO];
  for (let i = 0; i < 99; i++) { users.push(ethers.Wallet.createRandom().address); sps.push(owner.address); amts.push(eth("0.001")); toks.push(ZERO); }
  const receipt = await send(() => fresh.submitSettlement(users, sps, amts, toks, kc("bigbatch-100")));
  const blk = await rd(() => provider.getBlock("latest"));
  const gasUsed = receipt.gasUsed;
  const limit = blk.gasLimit;
  const pct = (Number(gasUsed) * 100 / Number(limit)).toFixed(2);
  console.log("100-item batch gasUsed:", gasUsed.toString(), "| block gasLimit:", limit.toString(), "| " + pct + "% of a block");
  chk("100-item batch fits in one block", gasUsed < limit, pct + "%");
  const bnonce = await rd(() => fresh.settlementNonce());
  const brec = await rd(() => fresh.getSettlement(bnonce));
  chk("batch processed 100 items (settled 1 + failed 99)", brec.settledCount === 1n && brec.failedCount === 99n, "settled=" + brec.settledCount + " failed=" + brec.failedCount);

  console.log(`\n=== edge cases: ${bad === 0 ? "ALL OK" : bad + " FAILED"} ===`);
  console.log("0x83c2… final: owner/paused restored to clean state.");
  if (bad > 0) process.exit(1);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
