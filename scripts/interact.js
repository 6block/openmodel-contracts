// Full M3 settlement lifecycle demo against a local chain.
//
// Run on an ephemeral in-process chain:   npx hardhat run scripts/interact.js
// Or against a persistent local node:     npx hardhat run scripts/interact.js --network localhost
//
// It walks the entire on-chain flow and prints state at each step:
//   deposit -> submitSettlement (deduct user, credit SP + platform fee)
//   -> SP withdraw -> user refund with timelock (uses time-travel).
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const FIL = (n) => ethers.parseEther(String(n));
const fmt = (wei) => ethers.formatEther(wei);
const NATIVE = ethers.ZeroAddress;

async function bal(c, who, label) {
  const b = await c.getUserBalance(who, NATIVE);
  console.log(`   balance[${label}] = ${fmt(b)} FIL`);
}

async function main() {
  const [operator, user, sp, platform] = await ethers.getSigners();
  console.log("operator/owner:", operator.address);
  console.log("user:         ", user.address);
  console.log("SP:           ", sp.address);

  console.log("\n[1] Deploy OpenModelSettlement (fee=5%, refundDelay=3600s)");
  const F = await ethers.getContractFactory("OpenModelSettlement");
  const c = await F.deploy(500, 3600);
  await c.waitForDeployment();
  console.log("   deployed at:", await c.getAddress());

  console.log("\n[2] User deposits 10 FIL");
  await c.connect(user).depositFIL({ value: FIL(10) });
  await bal(c, user.address, "user");

  console.log("\n[3] Operator submits a settlement: user owes SP 2 FIL");
  const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("batch-demo-1"));
  await c.submitSettlement([user.address], [sp.address], [FIL(2)], [NATIVE], detailsHash);
  await bal(c, user.address, "user (after -2)");
  console.log("   SP earnings   =", fmt(await c.getSPEarnings(sp.address, NATIVE)), "FIL  (2 - 5% fee)");
  console.log("   platform fee  =", fmt(await c.platformEarnings(NATIVE)), "FIL");

  console.log("\n[4] Dedup: resubmitting the SAME detailsHash must revert");
  try {
    await c.submitSettlement([user.address], [sp.address], [FIL(1)], [NATIVE], detailsHash);
    console.log("   ERROR: duplicate was accepted (bug!)");
  } catch (e) {
    console.log("   reverted as expected:", e.shortMessage || e.message.split("\n")[0]);
  }

  console.log("\n[5] SP withdraws earnings");
  const spBefore = await ethers.provider.getBalance(sp.address);
  const tx = await c.connect(sp).withdrawEarnings(NATIVE);
  const r = await tx.wait();
  const spAfter = await ethers.provider.getBalance(sp.address);
  console.log("   SP wallet delta =", fmt(spAfter - spBefore + r.gasUsed * r.gasPrice), "FIL (net of gas)");
  console.log("   SP earnings now =", fmt(await c.getSPEarnings(sp.address, NATIVE)), "FIL");

  console.log("\n[6] User requests refund of remaining 8 FIL (enters timelock)");
  await c.connect(user).requestRefund(NATIVE, FIL(8));
  await bal(c, user.address, "user (locked, 0 spendable)");

  console.log("\n[7] Claim BEFORE timelock expires must revert");
  try {
    await c.connect(user).claimRefund(1);
    console.log("   ERROR: early claim accepted (bug!)");
  } catch (e) {
    console.log("   reverted as expected:", e.shortMessage || e.message.split("\n")[0]);
  }

  console.log("\n[8] Time-travel +3601s, then claim succeeds");
  await time.increase(3601);
  const uBefore = await ethers.provider.getBalance(user.address);
  const tx2 = await c.connect(user).claimRefund(1);
  const r2 = await tx2.wait();
  const uAfter = await ethers.provider.getBalance(user.address);
  console.log("   user wallet delta =", fmt(uAfter - uBefore + r2.gasUsed * r2.gasPrice), "FIL (net of gas)");

  console.log("\n[9] Platform withdraws its fee");
  await c.withdrawPlatformEarnings(NATIVE, platform.address);
  console.log("   platform earnings now =", fmt(await c.platformEarnings(NATIVE)), "FIL");

  console.log("\nDONE — full settlement lifecycle verified on-chain.");
}

main().catch((e) => { console.error(e); process.exit(1); });
