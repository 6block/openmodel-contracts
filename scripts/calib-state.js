// Read-only dump of the settlement contract's on-chain state (no private key needed).
//   npx hardhat run scripts/calib-state.js --network calibration
// Optional: CADDR=0x... USER_ADDR=0x... to override contract / show a specific account.
const { ethers } = require("hardhat");

async function main() {
  const C = process.env.CADDR || "0x97a3d202CfF60dD369cdf8F7D514dAe36b469852";
  const c = await ethers.getContractAt("OpenModelSettlement", C);
  const FIL = ethers.ZeroAddress;
  const f = (x) => ethers.formatEther(x);
  const iso = (t) => new Date(Number(t) * 1000).toISOString();

  console.log("contract       :", C);
  console.log("owner          :", await c.owner());
  console.log("platformFeeBps :", (await c.platformFeeBps()).toString(), "(/10000)");
  console.log("refundDelaySec :", (await c.refundDelaySec()).toString());
  console.log("FIL supported  :", await c.supportedTokens(FIL));
  console.log("platformEarn FIL:", f(await c.platformEarnings(FIL)));

  // Per-account balances (optional)
  const who = process.env.USER_ADDR;
  if (who) {
    console.log(`\naccount ${who}`);
    console.log("  user balance   FIL:", f(await c.getUserBalance(who, FIL)));
    console.log("  SP earnings    FIL:", f(await c.getSPEarnings(who, FIL)));
    console.log("  locked(refund) FIL:", f(await c.lockedForRefund(who, FIL)));
  }

  // Settlement records (1-based, ++settlementNonce)
  const n = Number(await c.settlementNonce());
  console.log(`\nsettlement batches: ${n}`);
  for (let i = 1; i <= n; i++) {
    const s = await c.getSettlement(i);
    console.log(`  #${s.batchId} ${iso(s.timestamp)} total=${f(s.totalAmount)} FIL ` +
      `settled=${s.settledCount} failed=${s.failedCount} hash=${s.detailsHash.slice(0, 12)}…`);
  }

  // Refund requests (1-based, ++refundNonce)
  const rn = Number(await c.refundNonce());
  console.log(`\nrefund requests: ${rn}`);
  for (let i = 1; i <= rn; i++) {
    const r = await c.getRefundRequest(i);
    console.log(`  #${i} user=${r.user.slice(0, 12)}… amt=${f(r.amount)} FIL ` +
      `claimableAt=${iso(r.claimableAt)} claimed=${r.claimed} cancelled=${r.cancelled}`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
