const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "FIL");

  const platformFeeBps = 500; // 5%
  const refundDelaySec = 3600; // 1 hour

  const Settlement = await ethers.getContractFactory("OpenModelSettlement");
  const settlement = await Settlement.deploy(platformFeeBps, refundDelaySec);
  await settlement.waitForDeployment();

  const addr = await settlement.getAddress();
  console.log("OpenModelSettlement deployed to:", addr);
  console.log("Platform fee:", platformFeeBps, "bps (", platformFeeBps / 100, "%)");
  console.log("Refund delay:", refundDelaySec, "seconds");
  console.log("Owner:", deployer.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
