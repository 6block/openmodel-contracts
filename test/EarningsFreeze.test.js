const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// v1.1: earnings freeze window + arbiter confiscation.
// The default (freeze = 0) path is covered by the whole pre-existing suite;
// everything here exercises freeze > 0 behavior and the arbiter role.
describe("EarningsFreeze", function () {
  let settlement;
  let owner, user1, sp1, sp2, other;

  const FEE_BPS = 500; // 5%
  const REFUND_DELAY = 3600;
  const NATIVE = ethers.ZeroAddress;
  const FREEZE = 7 * 24 * 3600; // 7 days
  // v1.2: unlock times round UP to the next BUCKET boundary (freeze/8), so waits
  // that must guarantee maturation add one bucket of slack.
  const BUCKET = FREEZE / 8;
  const EVIDENCE = ethers.keccak256(ethers.toUtf8Bytes("evidence-bundle"));

  let batchSeq = 0;
  // Settles one item user→sp of `amountEth` FIL (sp is credited 95% after the 5% fee).
  async function settle(user, sp, amountEth) {
    const detailsHash = ethers.keccak256(ethers.toUtf8Bytes(`freeze-batch-${++batchSeq}`));
    await settlement.submitSettlement(
      [user.address],
      [sp.address],
      [ethers.parseEther(amountEth)],
      [NATIVE], ([user.address]).map(() => 0), ([user.address]).map(() => 0),
      detailsHash
    );
  }

  // Snapshot fixture: every test reverts the chain (state AND account balances), so
  // this file cannot drain shared signer funds needed by the other test file.
  async function deployFreezeFixture() {
    const [fOwner, fUser1, fSp1, fSp2, fOther] = await ethers.getSigners();
    const Settlement = await ethers.getContractFactory("OpenModelSettlement");
    const fSettlement = await Settlement.deploy(FEE_BPS, REFUND_DELAY);
    await fSettlement.waitForDeployment();
    await fSettlement.connect(fUser1).depositFIL({ value: ethers.parseEther("100") });
    return { fSettlement, fOwner, fUser1, fSp1, fSp2, fOther };
  }

  beforeEach(async function () {
    const f = await loadFixture(deployFreezeFixture);
    settlement = f.fSettlement;
    owner = f.fOwner;
    user1 = f.fUser1;
    sp1 = f.fSp1;
    sp2 = f.fSp2;
    other = f.fOther;
  });

  describe("configuration", function () {
    it("defaults to no freeze and deployer as arbiter", async function () {
      expect(await settlement.earningsFreezeSec()).to.equal(0);
      expect(await settlement.arbiter()).to.equal(owner.address);
    });

    it("owner can set the freeze window (with event)", async function () {
      await expect(settlement.setEarningsFreeze(FREEZE))
        .to.emit(settlement, "EarningsFreezeUpdated")
        .withArgs(0, FREEZE);
      expect(await settlement.earningsFreezeSec()).to.equal(FREEZE);
    });

    it("rejects non-owner and out-of-bound freeze updates", async function () {
      await expect(settlement.connect(user1).setEarningsFreeze(FREEZE)).to.be.revertedWith("not owner");
      const max = await settlement.MAX_EARNINGS_FREEZE();
      await expect(settlement.setEarningsFreeze(max + 1n)).to.be.revertedWith("freeze too long");
      await settlement.setEarningsFreeze(max); // boundary is allowed
    });

    it("owner can rotate the arbiter (with event); zero address rejected", async function () {
      await expect(settlement.setArbiter(other.address))
        .to.emit(settlement, "ArbiterUpdated")
        .withArgs(owner.address, other.address);
      expect(await settlement.arbiter()).to.equal(other.address);
      await expect(settlement.connect(user1).setArbiter(user1.address)).to.be.revertedWith("not owner");
      await expect(settlement.setArbiter(ethers.ZeroAddress)).to.be.revertedWith("invalid arbiter");
    });
  });

  describe("no freeze (pre-v1.1 parity)", function () {
    it("credits immediately and keeps the lockup queue empty", async function () {
      await settle(user1, sp1, "10");
      const earned = ethers.parseEther("9.5");
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(earned);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(earned);
      expect(await settlement.getTotalEarnings(sp1.address, NATIVE)).to.equal(earned);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(0);
      const [totalEntries] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(totalEntries).to.equal(0);
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, earned);
    });
  });

  describe("frozen credit lifecycle", function () {
    beforeEach(async function () {
      await settlement.setEarningsFreeze(FREEZE);
    });

    it("freezes a settled credit until the window elapses", async function () {
      await settle(user1, sp1, "10");
      const earned = ethers.parseEther("9.5");

      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(0);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(earned);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(0);
      expect(await settlement.getTotalEarnings(sp1.address, NATIVE)).to.equal(earned);

      const nowTs = await time.latest();
      const [unlockAt, amount] = await settlement.getLockup(sp1.address, NATIVE, 0);
      expect(amount).to.equal(earned);
      // Floor guarantee: never earlier than the configured freeze; rounding may
      // push it up to one bucket later, never the other way.
      expect(Number(unlockAt)).to.be.at.least(nowTs + FREEZE - 5);
      expect(Number(unlockAt)).to.be.at.most(nowTs + FREEZE + BUCKET + 5);

      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE)).to.be.revertedWith("no earnings");

      await time.increase(FREEZE + BUCKET + 1);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(earned);
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, earned);
      expect(await settlement.getTotalEarnings(sp1.address, NATIVE)).to.equal(0);
      const [totalEntries, cursor] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(cursor).to.equal(totalEntries); // queue fully consumed
    });

    it("releases strictly in FIFO order across batches", async function () {
      await settle(user1, sp1, "10"); // A → 9.5
      await time.increase(FREEZE / 2);
      await settle(user1, sp1, "20"); // B → 19

      // A matured (its rounded unlock is at most credit+FREEZE+BUCKET), B still
      // frozen (B's floor is a further FREEZE/2 away and BUCKET+10 < FREEZE/2).
      await time.increase(FREEZE / 2 + BUCKET + 10);
      const a = ethers.parseEther("9.5");
      const b = ethers.parseEther("19");
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(a);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(b);
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, a);

      // Then B matures.
      await time.increase(FREEZE / 2 + 10);
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, b);
    });

    it("merges same-batch items into a single lockup entry", async function () {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("merge-batch"));
      await settlement.submitSettlement(
        [user1.address, user1.address],
        [sp1.address, sp1.address],
        [ethers.parseEther("10"), ethers.parseEther("20")],
        [NATIVE, NATIVE], ([user1.address, user1.address]).map(() => 0), ([user1.address, user1.address]).map(() => 0),
        detailsHash
      );
      const [totalEntries] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(totalEntries).to.equal(1);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(ethers.parseEther("28.5"));
    });

    it("matureEarnings is permissionless and honors maxEntries", async function () {
      // Batches must land in DIFFERENT buckets to stay separate entries (that is
      // the point of maxEntries); anything closer than one bucket width merges.
      await settle(user1, sp1, "10"); // 9.5
      await time.increase(BUCKET + 60);
      await settle(user1, sp1, "20"); // 19
      await time.increase(BUCKET + 60);
      await settle(user1, sp1, "30"); // 28.5
      await time.increase(FREEZE + BUCKET + 1);

      await settlement.connect(other).matureEarnings(sp1.address, NATIVE, 2);
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(ethers.parseEther("28.5")); // 9.5+19
      await settlement.connect(other).matureEarnings(sp1.address, NATIVE, 0);
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(ethers.parseEther("57"));
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("57"));
    });

    it("keeps FIFO order when the freeze window is shortened", async function () {
      await settlement.setEarningsFreeze(1000);
      await settle(user1, sp1, "10"); // A: unlock in 1000s
      await settlement.setEarningsFreeze(10);
      await settle(user1, sp1, "20"); // B: unlock in 10s, but queued behind A

      await time.increase(20); // B's own window elapsed; A still frozen
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(0);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(ethers.parseEther("28.5"));
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE)).to.be.revertedWith("no earnings");

      await time.increase(1200); // past A's rounded unlock (<= 1000 + 1000/8) → both release
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("28.5"));
    });
  });

  // v1.2: unlock times round up to freeze/8 buckets so same-bucket credits merge.
  // This is what keeps the queue walkable: without it, one entry per settlement
  // batch (20-min cadence x 7-day freeze = 504 entries per SP) and withdraw gas
  // grows unboundedly the longer earnings sit unclaimed.
  // The mainnet trial settles in native FIL and (once whitelisted) in USDFC, an
  // 18-decimal ERC20. The freeze queue is keyed per (sp, token), so the two
  // currencies must mature and pay out independently — an SP withdrawing FIL
  // must not touch its frozen stablecoin credit, and vice versa.
  describe("frozen ERC20 credit (stablecoin path)", function () {
    let token, tokenAddr;
    const UNIT = (n) => ethers.parseUnits(n, 18); // USDFC-like: 18 decimals

    beforeEach(async function () {
      const Mock = await ethers.getContractFactory("MockERC20");
      token = await Mock.deploy("USD for Filecoin", "USDFC", 18);
      await token.waitForDeployment();
      tokenAddr = await token.getAddress();
      await settlement.addSupportedToken(tokenAddr);
      await token.mint(user1.address, UNIT("1000"));
      await token.connect(user1).approve(await settlement.getAddress(), UNIT("100"));
      await settlement.connect(user1).depositToken(tokenAddr, UNIT("100"));
      await settlement.setEarningsFreeze(FREEZE);
    });

    async function settleToken(user, sp, amount) {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes(`erc20-freeze-${++batchSeq}`));
      await settlement.submitSettlement([user.address], [sp.address], [amount], [tokenAddr], ([user.address]).map(() => 0), ([user.address]).map(() => 0), detailsHash);
    }

    it("freezes an ERC20 credit and pays the token out after the window", async function () {
      await settleToken(user1, sp1, UNIT("10"));
      const earned = UNIT("9.5"); // 5% fee

      expect(await settlement.getFrozenEarnings(sp1.address, tokenAddr)).to.equal(earned);
      expect(await settlement.getWithdrawableEarnings(sp1.address, tokenAddr)).to.equal(0);
      await expect(settlement.connect(sp1).withdrawEarnings(tokenAddr)).to.be.revertedWith("no earnings");

      await time.increase(FREEZE + BUCKET + 1);
      expect(await settlement.getWithdrawableEarnings(sp1.address, tokenAddr)).to.equal(earned);

      const before = await token.balanceOf(sp1.address);
      await expect(settlement.connect(sp1).withdrawEarnings(tokenAddr))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, tokenAddr, earned);
      // The ERC20 actually moved — the event alone would not prove transfer success.
      expect(await token.balanceOf(sp1.address)).to.equal(before + earned);
      expect(await settlement.getTotalEarnings(sp1.address, tokenAddr)).to.equal(0);
    });

    it("keeps FIL and ERC20 freeze queues independent", async function () {
      await settle(user1, sp1, "10");             // native FIL credit
      await settleToken(user1, sp1, UNIT("10"));  // stablecoin credit, same SP

      await time.increase(FREEZE + BUCKET + 1);
      // Withdrawing one currency must not consume or unlock the other.
      await settlement.connect(sp1).withdrawEarnings(tokenAddr);
      expect(await settlement.getTotalEarnings(sp1.address, tokenAddr)).to.equal(0);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE))
        .to.equal(ethers.parseEther("9.5"));
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE)).to.emit(settlement, "SPWithdrawn");
    });

    it("confiscates only the still-frozen ERC20 credit", async function () {
      await settleToken(user1, sp1, UNIT("10"));   // will mature
      await time.increase(FREEZE + BUCKET + 1);
      await settleToken(user1, sp1, UNIT("4"));    // still frozen

      await expect(settlement.confiscateFrozenEarnings(sp1.address, tokenAddr, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated")
        .withArgs(sp1.address, tokenAddr, UNIT("3.8"), EVIDENCE);
      // The matured credit survives seizure and is still withdrawable.
      expect(await settlement.getWithdrawableEarnings(sp1.address, tokenAddr)).to.equal(UNIT("9.5"));
    });
  });

  describe("freeze bucketing", function () {
    beforeEach(async function () {
      await settlement.setEarningsFreeze(FREEZE);
    });

    it("merges cross-batch credits landing in the same bucket", async function () {
      // Align so (now + FREEZE) sits just past a bucket boundary — otherwise a test
      // started within 20 minutes of a boundary would split the two credits into
      // adjacent buckets and flake on wall-clock luck.
      const t = await time.latest();
      await time.increase(BUCKET - ((t + FREEZE) % BUCKET) + 5);

      await settle(user1, sp1, "10"); // 9.5
      await time.increase(20 * 60);  // next settlement cycle, far inside one bucket (21h)
      await settle(user1, sp1, "20"); // 19

      const [totalEntries] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(totalEntries).to.equal(1);
      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(
        ethers.parseEther("28.5")
      );

      // The merged entry still honors the freeze floor of the LATER credit (its
      // rounded unlock is >= the later credit time + FREEZE).
      await time.increase(FREEZE - 10 * 60);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(0);
      await time.increase(BUCKET + 1);
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(
        ethers.parseEther("28.5")
      );
    });

    it("keeps credits one bucket apart in separate FIFO entries", async function () {
      await settle(user1, sp1, "10");
      await time.increase(BUCKET + 60);
      await settle(user1, sp1, "20");
      const [totalEntries] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(totalEntries).to.equal(2);
    });

    it("bounds the queue under a production settlement cadence", async function () {
      this.timeout(120000);
      // One full freeze window of 20-minute settlements: 504 batches. Pre-bucketing
      // this produced 504 entries; bucketing must keep it at ~9 (7d / 21h + 1).
      const CADENCE = 20 * 60;
      const BATCHES = FREEZE / CADENCE; // 504
      for (let i = 0; i < BATCHES; i++) {
        await settle(user1, sp1, "0.1"); // 504 * 0.1 = 50.4 of the 100 deposited
        await time.increase(CADENCE);
      }

      const [totalEntries] = await settlement.getLockupCount(sp1.address, NATIVE);
      expect(totalEntries).to.be.at.most(10);

      await time.increase(FREEZE + BUCKET + 1);
      const expected = ethers.parseEther((0.095 * BATCHES).toFixed(6));
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(expected);

      const tx = await settlement.connect(sp1).withdrawEarnings(NATIVE);
      const rc = await tx.wait();
      // Walking ~9 packed slots: must stay far under any block/message limit.
      expect(Number(rc.gasUsed)).to.be.below(300000);
    });
  });

  describe("confiscation", function () {
    beforeEach(async function () {
      await settlement.setEarningsFreeze(FREEZE);
    });

    it("rejects non-arbiter callers", async function () {
      await settle(user1, sp1, "10");
      await expect(
        settlement.connect(user1).confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE)
      ).to.be.revertedWith("not arbiter");
    });

    it("seizes all frozen earnings into the platform pool with evidence", async function () {
      await settle(user1, sp1, "10"); // sp 9.5, fee 0.5
      const seizedPreview = await settlement.confiscateFrozenEarnings.staticCall(
        sp1.address,
        NATIVE,
        EVIDENCE
      );
      expect(seizedPreview).to.equal(ethers.parseEther("9.5"));

      await expect(settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("9.5"), EVIDENCE);

      expect(await settlement.getFrozenEarnings(sp1.address, NATIVE)).to.equal(0);
      expect(await settlement.getTotalEarnings(sp1.address, NATIVE)).to.equal(0);
      expect(await settlement.platformEarnings(NATIVE)).to.equal(ethers.parseEther("10")); // 0.5 fee + 9.5 seized
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE)).to.be.revertedWith("no earnings");
    });

    it("never seizes matured earnings", async function () {
      await settle(user1, sp1, "10"); // A → 9.5
      await time.increase(FREEZE + BUCKET + 1); // A matures
      await settle(user1, sp1, "20"); // B → 19, frozen

      await expect(settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("19"), EVIDENCE);

      // A stays with the SP.
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("9.5"));
    });

    it("reverts when nothing is frozen", async function () {
      await settle(user1, sp1, "10");
      await time.increase(FREEZE + BUCKET + 1); // everything matured
      await expect(
        settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE)
      ).to.be.revertedWith("nothing frozen");
      await expect(
        settlement.confiscateFrozenEarnings(sp2.address, NATIVE, EVIDENCE)
      ).to.be.revertedWith("nothing frozen"); // sp with no earnings at all
    });

    it("spares matured entries stuck behind a frozen one (shortened freeze)", async function () {
      await settlement.setEarningsFreeze(1000);
      await settle(user1, sp1, "10"); // A frozen 1000s
      await settlement.setEarningsFreeze(10);
      await settle(user1, sp1, "20"); // B matures in 10s but sits behind A
      await time.increase(20);

      // Only A (still inside its window) is seizable; B already matured on its own terms.
      await expect(settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("9.5"), EVIDENCE);

      // With A gone, B is no longer stuck.
      expect(await settlement.getWithdrawableEarnings(sp1.address, NATIVE)).to.equal(ethers.parseEther("19"));
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("19"));
    });

    it("keeps accepting and releasing new credits after a confiscation", async function () {
      await settle(user1, sp1, "10");
      await settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE);
      await settle(user1, sp1, "30"); // C → 28.5
      await time.increase(FREEZE + BUCKET + 1);
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.emit(settlement, "SPWithdrawn")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("28.5"));
    });

    it("honors arbiter rotation", async function () {
      await settle(user1, sp1, "10");
      await settlement.setArbiter(other.address);
      await expect(
        settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE)
      ).to.be.revertedWith("not arbiter"); // old arbiter (owner) rejected
      await expect(settlement.connect(other).confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated");
    });

    it("works while paused (pause must not shield a caught provider)", async function () {
      await settle(user1, sp1, "10");
      await settlement.pause();
      await expect(settlement.confiscateFrozenEarnings(sp1.address, NATIVE, EVIDENCE))
        .to.emit(settlement, "EarningsConfiscated")
        .withArgs(sp1.address, NATIVE, ethers.parseEther("9.5"), EVIDENCE);
    });
  });
});
