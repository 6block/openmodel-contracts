// Dump funds for ALL users & SPs at once.
// Solidity mappings aren't enumerable, so addresses are DISCOVERED from events
// (Deposited/RefundRequested → users; SPWithdrawn → SPs) over a recent block range,
// plus any seeds in ADDRS (comma-separated) for SPs credited-but-not-yet-withdrawn.
// Read-only (no key).  npx hardhat run scripts/calib-all.js --network calibration
//   env: CADDR, ADDRS=0x..,0x.., LOOKBACK=60000, CHUNK=2880
const { ethers } = require("hardhat");

async function main() {
  const C = process.env.CADDR || "0x97a3d202CfF60dD369cdf8F7D514dAe36b469852";
  const c = await ethers.getContractAt("OpenModelSettlement", C);
  const provider = ethers.provider;
  const FIL = ethers.ZeroAddress;
  const f = (x) => ethers.formatEther(x);

  const head = await provider.getBlockNumber();
  const from = Math.max(0, head - Number(process.env.LOOKBACK || 60000));
  const chunk = Number(process.env.CHUNK || 2880); // glif getLogs range cap

  const addrs = new Set();
  (process.env.ADDRS || "").split(",").map((s) => s.trim()).filter(Boolean)
    .forEach((a) => addrs.add(ethers.getAddress(a)));

  async function scan(filter, argName) {
    for (let b = from; b <= head; b += chunk) {
      const to = Math.min(b + chunk - 1, head);
      try {
        for (const e of await c.queryFilter(filter, b, to)) addrs.add(e.args[argName]);
      } catch (err) {
        console.error(`  getLogs ${b}-${to} failed: ${(err.message || "").slice(0, 50)}`);
      }
    }
  }
  await scan(c.filters.Deposited(), "user");
  await scan(c.filters.RefundRequested(), "user");
  await scan(c.filters.SPWithdrawn(), "sp");

  console.log(`discovered ${addrs.size} addresses (blocks ${from}-${head})\n`);
  let tUser = 0n, tSP = 0n, tLock = 0n;
  console.log("address                                     userBal   spEarn   locked");
  for (const a of addrs) {
    const [ub, sp, lk] = await Promise.all([
      c.getUserBalance(a, FIL), c.getSPEarnings(a, FIL), c.lockedForRefund(a, FIL),
    ]);
    tUser += ub; tSP += sp; tLock += lk;
    if (ub > 0n || sp > 0n || lk > 0n) {
      console.log(`  ${a}  ${f(ub).padStart(8)}  ${f(sp).padStart(7)}  ${f(lk).padStart(6)}`);
    }
  }
  const platform = await c.platformEarnings(FIL);
  const onchain = await provider.getBalance(C);
  console.log("\n--- totals (FIL) ---");
  console.log("  user balances :", f(tUser));
  console.log("  SP earnings   :", f(tSP));
  console.log("  locked(refund):", f(tLock));
  console.log("  platform fees :", f(platform));
  console.log("  liabilities Σ :", f(tUser + tSP + platform), "(user+SP+platform; locked is part of user)");
  console.log("  contract holds:", f(onchain), "← should be ≥ liabilities Σ");
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
