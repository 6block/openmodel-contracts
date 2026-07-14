const { ethers } = require("hardhat");
async function main(){
  const addr = process.env.CADDR;
  const [op, user] = await ethers.getSigners();
  const c = await ethers.getContractAt("OpenModelSettlement", addr);
  await (await c.connect(user).depositFIL({value: ethers.parseEther("100")})).wait();
  console.log("user", user.address, "deposited 100 FIL; on-chain balance =",
    ethers.formatEther(await c.getUserBalance(user.address, ethers.ZeroAddress)), "FIL");
}
main().catch(e=>{console.error(e.message||e);process.exit(1)});
