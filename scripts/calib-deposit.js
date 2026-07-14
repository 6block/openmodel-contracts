// One-off: deposit tFIL for the test user into the Calibration settlement contract,
// so the automated gateway settlement has on-chain balance to settle against.
// Keys are loaded from .calib-keys.json (never printed). Run:
//   npx hardhat run scripts/calib-deposit.js --network calibration
const { ethers } = require("hardhat");
const fs = require("fs");
async function main() {
  const keys = JSON.parse(fs.readFileSync(__dirname + "/../.calib-keys.json"));
  const C = "0x83c264c95e7Ad4b30Caa5Bc60e75E317bf109E4F";
  const z = ethers.ZeroAddress;
  const amount = process.env.DEPOSIT_TFIL || "1";
  const user = new ethers.Wallet(keys.user, ethers.provider);
  const c = (await ethers.getContractAt("OpenModelSettlement", C)).connect(user);
  console.log("user", user.address, "depositing", amount, "tFIL ...");
  const before = await c.getUserBalance(user.address, z);
  const tx = await c.depositFIL({ value: ethers.parseEther(amount) });
  console.log("tx", tx.hash, "— waiting for mine ...");
  const r = await tx.wait();
  console.log("mined in block", r.blockNumber, "gasUsed", r.gasUsed.toString());
  const after = await c.getUserBalance(user.address, z);
  console.log("on-contract user FIL balance:", ethers.formatEther(before), "->", ethers.formatEther(after));
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
