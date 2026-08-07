// v1.3 batch stats: submitSettlement carries per-item requestCounts/tokenCounts;
// the batch record and the cumulative counters accumulate SETTLED items only, so
// debt re-submission cannot double-count and failed items never inflate the stats.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Batch inference stats (v1.3)", function () {
  let settlement, owner, user1, user2, sp1, sp2;
  const NATIVE = ethers.ZeroAddress;
  const FEE_BPS = 500;

  beforeEach(async function () {
    [owner, user1, user2, sp1, sp2] = await ethers.getSigners();
    const F = await ethers.getContractFactory("OpenModelSettlement");
    settlement = await F.deploy(FEE_BPS, 3600);
    await settlement.waitForDeployment();
    await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
  });

  it("exposes SCHEMA_VERSION = 3 so clients can detect the extended ABI", async function () {
    expect(await settlement.SCHEMA_VERSION()).to.equal(3);
  });

  it("stores per-batch stats and starts the cumulative counters from them", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-1"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [sp1.address, sp2.address],
      [ethers.parseEther("1"), ethers.parseEther("2")],
      [NATIVE, NATIVE],
      [3, 4],
      [1000, 2500],
      h
    );
    const rec = await settlement.getSettlement(1);
    expect(rec.requestCount).to.equal(7);
    expect(rec.tokenCount).to.equal(3500);
    expect(await settlement.cumulativeRequests()).to.equal(7);
    expect(await settlement.cumulativeTokens()).to.equal(3500);
  });

  it("excludes failed items (insufficient balance) from batch and cumulative stats", async function () {
    // user2 never deposited: item 2 fails and its stats must not be counted.
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-fail"));
    const tx = settlement.submitSettlement(
      [user1.address, user2.address],
      [sp1.address, sp2.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [5, 9],
      [500, 900],
      h
    );
    await expect(tx).to.emit(settlement, "SettlementItemFailed");
    const rec = await settlement.getSettlement(1);
    expect(rec.settledCount).to.equal(1);
    expect(rec.failedCount).to.equal(1);
    expect(rec.requestCount).to.equal(5);
    expect(rec.tokenCount).to.equal(500);
    expect(await settlement.cumulativeRequests()).to.equal(5);
    expect(await settlement.cumulativeTokens()).to.equal(500);
  });

  it("excludes zero-SP items from the stats", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-zerosp"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [ethers.ZeroAddress, sp1.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [11, 2],
      [1100, 200],
      h
    );
    const rec = await settlement.getSettlement(1);
    expect(rec.requestCount).to.equal(2);
    expect(rec.tokenCount).to.equal(200);
  });

  it("accumulates the cumulative counters across batches", async function () {
    const rounds = [[2, 200], [3, 300]];
    for (let i = 0; i < rounds.length; i++) {
      const h = ethers.keccak256(ethers.toUtf8Bytes("stats-cum-" + i));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [rounds[i][0]], [rounds[i][1]], h
      );
    }
    expect(await settlement.cumulativeRequests()).to.equal(5);
    expect(await settlement.cumulativeTokens()).to.equal(500);
    expect((await settlement.getSettlement(2)).requestCount).to.equal(3);
  });

  it("rejects mismatched stats array lengths", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-len"));
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [1, 2], [100], h
    )).to.be.revertedWith("array length mismatch");
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [1], [], h
    )).to.be.revertedWith("array length mismatch");
  });

  it("emits the stats in SettlementExecuted", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-evt"));
    const amount = ethers.parseEther("1");
    const fee = amount * BigInt(FEE_BPS) / 10000n;
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [amount], [NATIVE], [42], [98765], h
    )).to.emit(settlement, "SettlementExecuted")
      .withArgs(1, amount, fee, 1, 0, h, 42, 98765);
  });
});
