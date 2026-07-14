// Seed on-chain balances for the soak-test users on the local Hardhat chain.
// depositFIL() credits msg.sender, so we deposit from each user's own signer.
// Signer indices map to the wallets in sp-state-agent.yaml:
//   #1 0x7099... = client, #3 0x90F7... = userA, #5 0x9965... = userB, #6 0x976E... = userC
const { ethers } = require("hardhat");

async function main() {
  const addr = process.env.CADDR;
  if (!addr) throw new Error("set CADDR to the settlement contract address");
  const signers = await ethers.getSigners();
  const c = await ethers.getContractAt("OpenModelSettlement", addr);
  const want = { 1: "client", 3: "userA", 5: "userB", 6: "userC" };
  const amount = ethers.parseEther("500"); // 500 FIL = $1000 at $2/FIL — ample for 24h
  for (const [idx, name] of Object.entries(want)) {
    const s = signers[Number(idx)];
    await (await c.connect(s).depositFIL({ value: amount })).wait();
    const bal = await c.getUserBalance(s.address, ethers.ZeroAddress);
    console.log(`${name} ${s.address} balance = ${ethers.formatEther(bal)} FIL`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
