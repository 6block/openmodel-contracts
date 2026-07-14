// Non-dirtying verification that the enhanced access control is LIVE on the deployed
// long-term Calibration contract (address from deployments/calibration.json):
//   - a non-operator CANNOT submitSettlement ("not operator")
//   - a non-owner CANNOT pause ("not owner")
// Both calls REVERT, so contract state is unchanged; we re-read state afterwards to
// confirm it is still clean (not paused, operator still the deployer).
//   npx hardhat run scripts/calib-verify-newcontract.js --network calibration
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
async function expectRevert(name, thunk, frag) {
  try { await withRetry(async () => { const tx = await thunk(); if (tx && tx.wait) await tx.wait(); }, "exp"); console.log("BAD  " + name + " | NO revert"); return 1; }
  catch (e) { const m = (e.shortMessage || e.reason || e.message || ""); const ok = m.includes(frag); console.log((ok ? "OK   " : "BAD  ") + name + " | " + m.slice(0, 55)); return ok ? 0 : 1; }
}

async function main() {
  const rec = JSON.parse(fs.readFileSync("deployments/calibration.json", "utf8"));
  const keys = JSON.parse(fs.readFileSync(".calib-keys.json", "utf8"));
  const provider = ethers.provider;
  const user = new ethers.Wallet(keys.user, provider); // NOT owner, NOT operator
  console.log("contract:", rec.address);
  console.log("probing with non-privileged key:", user.address, "\n");

  const c = await ethers.getContractAt("OpenModelSettlement", rec.address, user);
  const ZERO = ethers.ZeroAddress;
  const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  let bad = 0;
  bad += await expectRevert("non-operator submitSettlement blocked",
    () => c.submitSettlement([user.address], [user.address], [ethers.parseEther("0.01")], [ZERO], kc("probe")), "not operator");
  bad += await expectRevert("non-owner pause() blocked", () => c.pause(), "not owner");

  // Confirm the reverts left state untouched.
  const paused = await withRetry(() => c.paused(), "paused");
  const operator = await withRetry(() => c.operator(), "operator");
  const cleanState = paused === false && operator.toLowerCase() === rec.operator.toLowerCase();
  console.log("\npost-check: paused=" + paused + " operator=" + operator);
  console.log((cleanState ? "OK   " : "BAD  ") + "state unchanged by the reverted calls");
  if (!cleanState) bad++;

  if (bad > 0) { console.error("\n" + bad + " check(s) FAILED"); process.exit(1); }
  console.log("\naccess control is LIVE on the long-term contract; state stays clean.");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
