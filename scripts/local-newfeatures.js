// On the persistent local Hardhat chain: fresh-deploy the NEW OpenModelSettlement and
// exercise the two new features (operator/owner separation + emergency pause).
// Hardhat mines instantly, so no retry/wait juggling. Run:
//   npx hardhat run scripts/local-newfeatures.js --network localhost
const { ethers } = require("hardhat");
const ZERO = ethers.ZeroAddress;
const eth = (n) => ethers.parseEther(n);
const kc = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
let pass = 0, fail = 0;
function ok(n, c, d) { console.log((c ? "PASS" : "FAIL") + " | " + n + (d ? " | " + d : "")); c ? pass++ : fail++; }
async function expectRevert(name, p, frag) {
  try { const tx = await p; if (tx && tx.wait) await tx.wait(); ok(name, false, "NO revert"); }
  catch (e) { const m = e.shortMessage || e.reason || e.message || ""; ok(name, frag ? m.includes(frag) : true, m.slice(0, 40)); }
}
async function main() {
  const [owner, user, sp] = await ethers.getSigners();
  const S = await ethers.getContractFactory("OpenModelSettlement");
  const c = await S.deploy(500, 180); await c.waitForDeployment();
  console.log("deployed:", await c.getAddress(), "| owner/operator:", owner.address, "\n");

  // ---- operator / owner separation ----
  ok("operator defaults to deployer", (await c.operator()).toLowerCase() === owner.address.toLowerCase());
  await (await c.connect(user).depositFIL({ value: eth("1") })).wait();
  ok("user deposited 1 FIL", (await c.getUserBalance(user.address, ZERO)) === eth("1"));
  await (await c.setOperator(user.address)).wait();
  ok("owner rotated operator -> user", (await c.operator()).toLowerCase() === user.address.toLowerCase());
  await expectRevert("owner (non-operator) CANNOT settle",
    c.connect(owner).submitSettlement([user.address], [sp.address], [eth("0.1")], [ZERO], kc("b1")), "not operator");
  await (await c.connect(user).submitSettlement([user.address], [sp.address], [eth("0.1")], [ZERO], kc("b1"))).wait();
  ok("operator settled (user 1 -> 0.9)", (await c.getUserBalance(user.address, ZERO)) === eth("0.9"));
  await (await c.setPlatformFee(300)).wait();
  ok("owner keeps admin (setPlatformFee)", Number(await c.platformFeeBps()) === 300);

  // ---- emergency pause ----
  await (await c.pause()).wait();
  ok("paused == true", (await c.paused()) === true);
  await expectRevert("deposit blocked while paused", c.connect(user).depositFIL({ value: eth("0.1") }), "paused");
  await expectRevert("settlement blocked while paused",
    c.connect(user).submitSettlement([user.address], [sp.address], [eth("0.1")], [ZERO], kc("b2")), "paused");
  await (await c.connect(user).requestRefund(ZERO, eth("0.2"))).wait();
  ok("refund request OPEN while paused", true);
  await (await c.connect(sp).withdrawEarnings(ZERO)).wait();
  ok("SP withdraw OPEN while paused", true);
  await (await c.unpause()).wait();
  ok("unpaused", (await c.paused()) === false);
  await (await c.connect(user).depositFIL({ value: eth("0.05") })).wait();
  ok("deposit works after unpause", true);

  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
