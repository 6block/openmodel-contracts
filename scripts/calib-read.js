const { ethers } = require("hardhat");
async function main(){
  const C="0x83c264c95e7Ad4b30Caa5Bc60e75E317bf109E4F";
  const c = await ethers.getContractAt("OpenModelSettlement", C);
  const z = ethers.ZeroAddress;
  const op="0x01ac683ab8A0DB80F1f05F79946cc4F65B490a08", user="0x9875c8D91fE91199D7B9207d78f5A592EFCc6f88";
  console.log("platformFeeBps :", (await c.platformFeeBps()).toString(), "(after setPlatformFee)");
  console.log("refundDelaySec :", (await c.refundDelaySec()).toString());
  console.log("settlementNonce:", (await c.settlementNonce()).toString(), "(settlement batches submitted)");
  console.log("refundNonce    :", (await c.refundNonce()).toString(), "(refund requests)");
  console.log("user FIL bal   :", ethers.formatEther(await c.getUserBalance(user, z)), "(should be 0 after tests)");
  console.log("SP earnings FIL:", ethers.formatEther(await c.getSPEarnings(op, z)), "(should be 0 after withdrawal)");
  console.log("platform FIL   :", ethers.formatEther(await c.platformEarnings(z)), "(should be 0 after withdrawal)");
}
main().catch(e=>{console.error(e.message||e);process.exit(1)});
