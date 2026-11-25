// v1.4 batch stats: submitSettlement carries per-item requestCounts plus a per-item
// volume vector; the batch record and the cumulative counters accumulate SETTLED items
// only, so debt re-submission cannot double-count and failed items never inflate the
// stats. Each vector is indexed by the contract's UNIT_* constants, so a network that
// serves tokens and images reports each in its own counter.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { UNIT_TOKEN, UNIT_IMAGE, UNIT_AUDIO_SECOND, UNIT_CHARACTER, tokenVolume } = require("./helpers");

describe("Batch inference stats (v1.4)", function () {
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

  it("exposes SCHEMA_VERSION = 4 so clients can detect the extended ABI", async function () {
    expect(await settlement.SCHEMA_VERSION()).to.equal(4);
  });

  it("stores per-batch stats and starts the cumulative counters from them", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-1"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [sp1.address, sp2.address],
      [ethers.parseEther("1"), ethers.parseEther("2")],
      [NATIVE, NATIVE],
      [3, 4], [[1000,0,0,0], [2500,0,0,0]], 
      h
    );
    const rec = await settlement.getSettlement(1);
    expect(rec.requestCount).to.equal(7);
    expect(rec.volumeByUnit[UNIT_TOKEN]).to.equal(3500);
    expect(await settlement.cumulativeRequests()).to.equal(7);
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(3500);
  });

  it("excludes failed items (insufficient balance) from batch and cumulative stats", async function () {
    // user2 never deposited: item 2 fails and its stats must not be counted.
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-fail"));
    const tx = settlement.submitSettlement(
      [user1.address, user2.address],
      [sp1.address, sp2.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [5, 9], [[500,0,0,0], [900,0,0,0]], 
      h
    );
    await expect(tx).to.emit(settlement, "SettlementItemFailed");
    const rec = await settlement.getSettlement(1);
    expect(rec.settledCount).to.equal(1);
    expect(rec.failedCount).to.equal(1);
    expect(rec.requestCount).to.equal(5);
    expect(rec.volumeByUnit[UNIT_TOKEN]).to.equal(500);
    expect(await settlement.cumulativeRequests()).to.equal(5);
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(500);
  });

  it("excludes zero-SP items from the stats", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-zerosp"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [ethers.ZeroAddress, sp1.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [11, 2], [[1100,0,0,0], [200,0,0,0]], 
      h
    );
    const rec = await settlement.getSettlement(1);
    expect(rec.requestCount).to.equal(2);
    expect(rec.volumeByUnit[UNIT_TOKEN]).to.equal(200);
  });

  it("accumulates the cumulative counters across batches", async function () {
    const rounds = [[2, 200], [3, 300]];
    for (let i = 0; i < rounds.length; i++) {
      const h = ethers.keccak256(ethers.toUtf8Bytes("stats-cum-" + i));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [rounds[i][0]], [tokenVolume(rounds[i][1])], h
      );
    }
    expect(await settlement.cumulativeRequests()).to.equal(5);
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(500);
    expect((await settlement.getSettlement(2)).requestCount).to.equal(3);
  });

  it("rejects mismatched stats array lengths", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-len"));
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [1, 2], [[100,0,0,0]],  h
    )).to.be.revertedWith("array length mismatch");
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [1], [], h
    )).to.be.revertedWith("array length mismatch");
  });

  it("emits the stats in SettlementExecuted", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-evt"));
    const amount = ethers.parseEther("1");
    const fee = amount * BigInt(FEE_BPS) / 10000n;
    const volume = [0, 0, 0, 0];
    volume[UNIT_TOKEN] = 98765;
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [amount], [NATIVE], [42], [[98765,0,0,0]],  h
    )).to.emit(settlement, "SettlementExecuted")
      .withArgs(1, amount, fee, 1, 0, h, 42, volume);
  });

  it("counts each unit in its own counter, keeping images out of the token total", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-mixed"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [sp1.address, sp1.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [1, 1], [[1200,0,0,0], [0,4,0,0]], 
      h
    );
    const rec = await settlement.getSettlement(1);
    expect(rec.volumeByUnit[UNIT_TOKEN]).to.equal(1200);
    expect(rec.volumeByUnit[UNIT_IMAGE]).to.equal(4);
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(1200);
    expect(await settlement.cumulativeVolume(UNIT_IMAGE)).to.equal(4);
    // The deprecated scalar mirrors token volume only — an image must never appear in it.
    expect(await settlement.cumulativeTokens()).to.equal(1200);
  });

  it("counts a failed image item's volume 0 while a text item's still counts", async function () {
    // The invariant this shape exists to protect: one batch, two units, and the item
    // that fails must contribute nothing to ANY unit. A batch-level total could not do
    // this — it would have counted the image before the item was skipped.
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-mixed-fail"));
    const tx = settlement.submitSettlement(
      [user1.address, user2.address],
      [sp1.address, sp1.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [1, 1], [[1200,0,0,0], [0,4,0,0]],
      h
    );
    await expect(tx).to.emit(settlement, "SettlementItemFailed")
      .withArgs(1, 1, user2.address, "insufficient balance");
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(1200);
    expect(await settlement.cumulativeVolume(UNIT_IMAGE)).to.equal(0);
  });

  it("exposes the unit constants the off-chain biller indexes by", async function () {
    expect(await settlement.UNIT_TOKEN()).to.equal(UNIT_TOKEN);
    expect(await settlement.UNIT_IMAGE()).to.equal(UNIT_IMAGE);
    expect(await settlement.UNIT_AUDIO_SECOND()).to.equal(UNIT_AUDIO_SECOND);
    expect(await settlement.UNIT_CHARACTER()).to.equal(UNIT_CHARACTER);
    expect(await settlement.UNIT_COUNT()).to.equal(4);
  });

  it("tallies speech volume in its own columns: seconds for ASR, characters for TTS", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-speech"));
    await settlement.submitSettlement(
      [user1.address, user1.address],
      [sp1.address, sp1.address],
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [NATIVE, NATIVE],
      [2, 3],
      [[0,0,47,0], [0,0,0,1250]],
      h
    );
    expect(await settlement.cumulativeVolume(UNIT_AUDIO_SECOND)).to.equal(47);
    expect(await settlement.cumulativeVolume(UNIT_CHARACTER)).to.equal(1250);
    // Neither speech unit leaks into the token column or its deprecated mirror.
    expect(await settlement.cumulativeVolume(UNIT_TOKEN)).to.equal(0);
    expect(await settlement.cumulativeTokens()).to.equal(0);
  });

  it("refuses a volume vector with the wrong number of unit columns", async function () {
    const h = ethers.keccak256(ethers.toUtf8Bytes("stats-badvec"));
    // UNIT_COUNT is part of the ABI: a fixed-size inner array whose length the encoder
    // enforces. Two columns is not four, so the call cannot even be built — a client
    // wired to the wrong column count dies here rather than filing volume under the
    // wrong unit. Asserted at the encoder because that is where it actually stops.
    await expect(settlement.submitSettlement(
      [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], [1], [[1, 2]], h
    )).to.be.rejectedWith(/wrong length/i);
  });
});
