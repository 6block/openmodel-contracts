// Focused, EVIDENCED test of setOperator (set + change the operator/admin) on the
// LONG-TERM Calibration contract (address from deployments/calibration.json):
//   1) operator starts as the deployer,
//   2) a NON-owner cannot setOperator ("not owner") — revert, no state change,
//   3) the owner CHANGES the operator to another key,
//   4) the change TAKES EFFECT: the OLD operator can no longer submitSettlement,
//   5) the owner CHANGES it BACK, leaving the long-term contract with its original
//      operator (clean config; only two setOperator txs of history).
//   npx hardhat run scripts/calib-operator-rotation.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");

const RETRYABLE = /socket|network|TLS|ECONN|ETIMEDOUT|timeout|disconnect|503|502|bad response|detect network|SERVER_ERROR/i;
const REVERTY = /revert|not operator|not owner|paused|invalid|insufficient/i;
async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const m = (e.shortMessage || e.message || "") + "";
      if (REVERTY.test(m)) throw e;
      if (RETRYABLE.test(m) && i < 5) { console.log(`  (retry ${label} #${i + 1})`); await new Promise(r => setTimeout(r, 5000)); continue; }
      throw e;
    }
  }
  throw last;
}
const send = (thunk) => withRetry(async () => { const tx = await thunk(); return await tx.wait(); }, "send");
const rd = (thunk) => withRetry(thunk, "read");
async function expectRevert(name, thunk, frag) {
  try { await withRetry(async () => { const tx = await thunk(); if (tx && tx.wait) await tx.wait(); }, "exp"); console.log("BAD  " + name + " | NO revert"); return 1; }
  catch (e) { const m = (e.shortMessage || e.reason || e.message || ""); const ok = m.includes(frag); console.log((ok ? "OK   " : "BAD  ") + name + " | " + m.slice(0, 50)); return ok ? 0 : 1; }
}

async function main() {
  const rec = JSON.parse(fs.readFileSync("deployments/calibration.json", "utf8"));
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const owner = new ethers.Wallet(keys.operator, provider); // owner AND initial operator (0x01ac…)
  const other = new ethers.Wallet(keys.user, provider);     // non-owner key (0x9875…)
  console.log("contract:", rec.address);
  console.log("owner/operator:", owner.address);
  console.log("other (non-owner):", other.address, "\n");

  const c = await ethers.getContractAt("OpenModelSettlement", rec.address, owner);
  const ZERO = ethers.ZeroAddress;
  const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  let bad = 0;

  const orig = await rd(() => c.operator());
  console.log("initial operator =", orig);
  if (orig.toLowerCase() !== owner.address.toLowerCase()) { console.log("BAD  operator should start as deployer"); bad++; }
  else console.log("OK   operator starts as deployer");

  // 1) a NON-owner cannot change the operator
  bad += await expectRevert("non-owner setOperator blocked", () => c.connect(other).setOperator(other.address), "not owner");

  // 2) the owner CHANGES the operator to `other`
  await send(() => c.setOperator(other.address));
  const rotated = await rd(() => c.operator());
  if (rotated.toLowerCase() === other.address.toLowerCase()) { console.log("OK   owner changed operator -> " + rotated); }
  else { console.log("BAD  change failed, operator = " + rotated); bad++; }

  // 3) the change TAKES EFFECT: the OLD operator (owner) can no longer settle
  bad += await expectRevert("old operator can no longer settle",
    () => c.submitSettlement([owner.address], [owner.address], [ethers.parseEther("0.01")], [ZERO], kc("probe-rotation")), "not operator");

  // 4) the owner CHANGES it back -> restore the long-term contract's clean config
  await send(() => c.setOperator(owner.address));
  const restored = await rd(() => c.operator());
  if (restored.toLowerCase() === owner.address.toLowerCase()) { console.log("OK   operator changed back -> " + restored); }
  else { console.log("BAD  restore failed, operator = " + restored); bad++; }

  console.log("\nfinal operator =", restored, "(equals deployer — long-term contract left correctly configured)");
  if (bad > 0) { console.error("\n" + bad + " check(s) FAILED"); process.exit(1); }
  console.log("\nsetOperator verified on the long-term contract: default + non-owner-blocked + change + effect + change-back; config restored.");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
