const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("OpenModelSettlement", function () {
  let settlement;
  let mockToken;
  let owner, user1, user2, sp1, sp2, platformWallet;

  const FEE_BPS = 500; // 5%
  const REFUND_DELAY = 3600; // 1 hour
  const NATIVE = ethers.ZeroAddress;

  async function deployFixture() {
    [owner, user1, user2, sp1, sp2, platformWallet] = await ethers.getSigners();

    const Settlement = await ethers.getContractFactory("OpenModelSettlement");
    settlement = await Settlement.deploy(FEE_BPS, REFUND_DELAY);
    await settlement.waitForDeployment();

    // Deploy a mock ERC20 token (USDC-like, 6 decimals)
    const MockToken = await ethers.getContractFactory("MockERC20");
    mockToken = await MockToken.deploy("USD Coin", "USDC", 6);
    await mockToken.waitForDeployment();

    // Add mock token to whitelist
    await settlement.addSupportedToken(await mockToken.getAddress());

    // Mint tokens to users
    const mintAmount = ethers.parseUnits("10000", 6); // 10000 USDC
    await mockToken.mint(user1.address, mintAmount);
    await mockToken.mint(user2.address, mintAmount);
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ==================== Deposit Tests ====================

  describe("Deposit", function () {
    it("should deposit FIL", async function () {
      const amount = ethers.parseEther("10");
      await expect(settlement.connect(user1).depositFIL({ value: amount }))
        .to.emit(settlement, "Deposited")
        .withArgs(user1.address, NATIVE, amount);

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(amount);
    });

    it("should deposit FIL via receive()", async function () {
      const amount = ethers.parseEther("5");
      await expect(user1.sendTransaction({
        to: await settlement.getAddress(),
        value: amount,
      })).to.emit(settlement, "Deposited")
        .withArgs(user1.address, NATIVE, amount);

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(amount);
    });

    it("should reject zero FIL deposit", async function () {
      await expect(settlement.connect(user1).depositFIL({ value: 0 }))
        .to.be.revertedWith("zero deposit");
    });

    it("should deposit ERC20 token", async function () {
      const amount = ethers.parseUnits("100", 6);
      const tokenAddr = await mockToken.getAddress();
      await mockToken.connect(user1).approve(await settlement.getAddress(), amount);

      await expect(settlement.connect(user1).depositToken(tokenAddr, amount))
        .to.emit(settlement, "Deposited")
        .withArgs(user1.address, tokenAddr, amount);

      expect(await settlement.getUserBalance(user1.address, tokenAddr)).to.equal(amount);
    });

    it("should reject deposit of unsupported token", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(settlement.connect(user1).depositToken(fakeToken, 100))
        .to.be.revertedWith("token not supported");
    });

    it("should reject zero ERC20 deposit", async function () {
      const tokenAddr = await mockToken.getAddress();
      await expect(settlement.connect(user1).depositToken(tokenAddr, 0))
        .to.be.revertedWith("zero deposit");
    });

    it("should reject depositToken with native address", async function () {
      await expect(settlement.connect(user1).depositToken(NATIVE, 100))
        .to.be.revertedWith("use depositFIL for native");
    });

    it("should accumulate multiple deposits", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("3") });
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("7") });
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("10"));
    });
  });

  // ==================== Settlement Tests ====================

  describe("Settlement", function () {
    const depositAmount = ethers.parseEther("100");

    beforeEach(async function () {
      await settlement.connect(user1).depositFIL({ value: depositAmount });
      await settlement.connect(user2).depositFIL({ value: depositAmount });
    });

    it("should settle a single item", async function () {
      const amount = ethers.parseEther("10");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("batch-1"));

      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [amount], [NATIVE], detailsHash
      )).to.emit(settlement, "SettlementExecuted");

      const fee = amount * BigInt(FEE_BPS) / 10000n;
      const spAmount = amount - fee;

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount - amount);
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(spAmount);
      expect(await settlement.platformEarnings(NATIVE)).to.equal(fee);
    });

    it("should settle batch with multiple items", async function () {
      const amounts = [ethers.parseEther("5"), ethers.parseEther("8")];
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("batch-2"));

      await settlement.submitSettlement(
        [user1.address, user2.address],
        [sp1.address, sp2.address],
        amounts,
        [NATIVE, NATIVE],
        detailsHash
      );

      const fee1 = amounts[0] * BigInt(FEE_BPS) / 10000n;
      const fee2 = amounts[1] * BigInt(FEE_BPS) / 10000n;

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount - amounts[0]);
      expect(await settlement.getUserBalance(user2.address, NATIVE)).to.equal(depositAmount - amounts[1]);
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(amounts[0] - fee1);
      expect(await settlement.getSPEarnings(sp2.address, NATIVE)).to.equal(amounts[1] - fee2);
    });

    it("should reject duplicate detailsHash", async function () {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("batch-dup"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], detailsHash
      );

      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], detailsHash
      )).to.be.revertedWith("batch already processed");
    });

    it("should skip items with insufficient balance (partial settlement)", async function () {
      const tooMuch = ethers.parseEther("200"); // user1 only has 100
      const normal = ethers.parseEther("5");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("batch-partial"));

      const tx = await settlement.submitSettlement(
        [user1.address, user2.address],
        [sp1.address, sp1.address],
        [tooMuch, normal],
        [NATIVE, NATIVE],
        detailsHash
      );

      await expect(tx).to.emit(settlement, "SettlementItemFailed")
        .withArgs(1, 0, user1.address, "insufficient balance");

      // user1 balance unchanged (skipped)
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
      // user2 balance deducted
      expect(await settlement.getUserBalance(user2.address, NATIVE)).to.equal(depositAmount - normal);

      const record = await settlement.getSettlement(1);
      expect(record.settledCount).to.equal(1);
      expect(record.failedCount).to.equal(1);
    });

    it("should reject empty batch", async function () {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("empty"));
      await expect(settlement.submitSettlement([], [], [], [], detailsHash))
        .to.be.revertedWith("invalid batch size");
    });

    it("should reject mismatched array lengths", async function () {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("mismatch"));
      await expect(settlement.submitSettlement(
        [user1.address, user2.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], detailsHash
      )).to.be.revertedWith("array length mismatch");
    });

    it("should reject settlement from a non-operator", async function () {
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("unauth"));
      await expect(settlement.connect(user1).submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], detailsHash
      )).to.be.revertedWith("not operator");
    });

    it("should settle with ERC20 token", async function () {
      const tokenAddr = await mockToken.getAddress();
      const depositAmt = ethers.parseUnits("500", 6);
      await mockToken.connect(user1).approve(await settlement.getAddress(), depositAmt);
      await settlement.connect(user1).depositToken(tokenAddr, depositAmt);

      const settleAmt = ethers.parseUnits("100", 6);
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("erc20-batch"));

      await settlement.submitSettlement(
        [user1.address], [sp1.address], [settleAmt], [tokenAddr], detailsHash
      );

      const fee = settleAmt * BigInt(FEE_BPS) / 10000n;
      expect(await settlement.getUserBalance(user1.address, tokenAddr)).to.equal(depositAmt - settleAmt);
      expect(await settlement.getSPEarnings(sp1.address, tokenAddr)).to.equal(settleAmt - fee);
    });

    it("should store settlement record", async function () {
      const amount = ethers.parseEther("10");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("record-test"));

      await settlement.submitSettlement(
        [user1.address], [sp1.address], [amount], [NATIVE], detailsHash
      );

      const record = await settlement.getSettlement(1);
      expect(record.batchId).to.equal(1);
      expect(record.totalAmount).to.equal(amount);
      expect(record.settledCount).to.equal(1);
      expect(record.failedCount).to.equal(0);
      expect(record.detailsHash).to.equal(detailsHash);
    });
  });

  // ==================== Refund Timelock Tests ====================

  describe("Refund Timelock", function () {
    const depositAmount = ethers.parseEther("10");

    beforeEach(async function () {
      await settlement.connect(user1).depositFIL({ value: depositAmount });
    });

    it("should request refund and lock (not deduct) balance", async function () {
      const refundAmount = ethers.parseEther("5");
      await expect(settlement.connect(user1).requestRefund(NATIVE, refundAmount))
        .to.emit(settlement, "RefundRequested");

      // Balance is NOT deducted on request — only locked, so settlement keeps priority.
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
      expect(await settlement.lockedForRefund(user1.address, NATIVE)).to.equal(refundAmount);
    });

    it("should reject claim before timelock expires", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await expect(settlement.connect(user1).claimRefund(1))
        .to.be.revertedWith("too early");
    });

    it("should allow claim after timelock expires", async function () {
      const refundAmount = ethers.parseEther("5");
      await settlement.connect(user1).requestRefund(NATIVE, refundAmount);

      const balanceBefore = await ethers.provider.getBalance(user1.address);
      await time.increase(REFUND_DELAY + 1);

      const tx = await settlement.connect(user1).claimRefund(1);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter + gasCost - balanceBefore).to.equal(refundAmount);
    });

    it("should allow settlement to deduct from full balance during pending refund", async function () {
      // User deposits 10, requests refund of 5 → balance still 10 (5 locked, not deducted).
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));

      // Settlement draws from the FULL balance (refund only locked it).
      const settleAmount = ethers.parseEther("3");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("during-refund"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [settleAmount], [NATIVE], detailsHash
      );

      // Remaining balance: 10 - 3 = 7
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("7"));
    });

    it("defeats the front-running free-rider: a full-balance refund request does NOT dodge settlement", async function () {
      // Attack: deposit 10, request a refund for the ENTIRE balance, hoping the
      // operator's settlement then sees "insufficient" and skips (free ride).
      await settlement.connect(user1).requestRefund(NATIVE, depositAmount); // lock all 10

      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("free-rider"));
      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("4")], [NATIVE], detailsHash
      )).to.emit(settlement, "SettlementExecuted");

      const rec = await settlement.getSettlement(1);
      expect(rec.settledCount).to.equal(1); // charged, NOT skipped
      expect(rec.failedCount).to.equal(0);
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("6"));

      // Cancelling the now-over-locked refund yields no free money.
      await settlement.connect(user1).cancelRefund(1);
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("6"));
    });

    it("claim reverts when settlement consumed the balance during the timelock", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, depositAmount); // lock all 10
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("consume-all"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [depositAmount], [NATIVE], detailsHash
      ); // balance -> 0
      await time.increase(REFUND_DELAY + 1);
      await expect(settlement.connect(user1).claimRefund(1))
        .to.be.revertedWith("balance already settled");
    });

    it("should cancel pending refund and release the lock", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      // balance never dropped; 5 is locked
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
      expect(await settlement.lockedForRefund(user1.address, NATIVE)).to.equal(ethers.parseEther("5"));

      await expect(settlement.connect(user1).cancelRefund(1))
        .to.emit(settlement, "RefundCancelled");

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
      expect(await settlement.lockedForRefund(user1.address, NATIVE)).to.equal(0);
    });

    it("should reject double claim", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await time.increase(REFUND_DELAY + 1);
      await settlement.connect(user1).claimRefund(1);

      await expect(settlement.connect(user1).claimRefund(1))
        .to.be.revertedWith("already claimed");
    });

    it("should reject claim of cancelled refund", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await settlement.connect(user1).cancelRefund(1);
      await time.increase(REFUND_DELAY + 1);

      await expect(settlement.connect(user1).claimRefund(1))
        .to.be.revertedWith("cancelled");
    });

    it("should reject refund of more than free balance", async function () {
      await expect(settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("20")))
        .to.be.revertedWith("insufficient free balance");
    });

    it("should reject refund request from wrong user", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await time.increase(REFUND_DELAY + 1);

      await expect(settlement.connect(user2).claimRefund(1))
        .to.be.revertedWith("not your request");
    });
  });

  // ==================== Withdrawal Tests ====================

  describe("Withdrawal", function () {
    it("should allow SP to withdraw FIL earnings", async function () {
      // Setup: deposit and settle
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("withdraw-test"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("10")], [NATIVE], detailsHash
      );

      const expectedEarnings = ethers.parseEther("10") - (ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n);
      const balanceBefore = await ethers.provider.getBalance(sp1.address);

      const tx = await settlement.connect(sp1).withdrawEarnings(NATIVE);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(sp1.address);
      expect(balanceAfter + gasCost - balanceBefore).to.equal(expectedEarnings);
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(0);
    });

    it("should allow SP to withdraw ERC20 earnings", async function () {
      const tokenAddr = await mockToken.getAddress();
      const depositAmt = ethers.parseUnits("100", 6);
      await mockToken.connect(user1).approve(await settlement.getAddress(), depositAmt);
      await settlement.connect(user1).depositToken(tokenAddr, depositAmt);

      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("erc20-withdraw"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [depositAmt], [tokenAddr], detailsHash
      );

      const fee = depositAmt * BigInt(FEE_BPS) / 10000n;
      const expectedEarnings = depositAmt - fee;

      await settlement.connect(sp1).withdrawEarnings(tokenAddr);
      expect(await mockToken.balanceOf(sp1.address)).to.equal(expectedEarnings);
    });

    it("should reject withdrawal with no earnings", async function () {
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE))
        .to.be.revertedWith("no earnings");
    });

    it("should allow platform withdrawal", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("platform-withdraw"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("10")], [NATIVE], detailsHash
      );

      const expectedFee = ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n;
      const balanceBefore = await ethers.provider.getBalance(platformWallet.address);

      await settlement.withdrawPlatformEarnings(NATIVE, platformWallet.address);
      const balanceAfter = await ethers.provider.getBalance(platformWallet.address);

      expect(balanceAfter - balanceBefore).to.equal(expectedFee);
    });
  });

  // ==================== Admin Tests ====================

  describe("Admin", function () {
    it("should update platform fee", async function () {
      await expect(settlement.setPlatformFee(1000))
        .to.emit(settlement, "PlatformFeeUpdated")
        .withArgs(FEE_BPS, 1000);
      expect(await settlement.platformFeeBps()).to.equal(1000);
    });

    it("should reject fee above max", async function () {
      await expect(settlement.setPlatformFee(3001))
        .to.be.revertedWith("fee too high");
    });

    it("should update refund delay", async function () {
      await expect(settlement.setRefundDelay(7200))
        .to.emit(settlement, "RefundDelayUpdated")
        .withArgs(REFUND_DELAY, 7200);
    });

    it("should add and remove supported tokens", async function () {
      const newToken = ethers.Wallet.createRandom().address;
      await settlement.addSupportedToken(newToken);
      expect(await settlement.supportedTokens(newToken)).to.be.true;

      await settlement.removeSupportedToken(newToken);
      expect(await settlement.supportedTokens(newToken)).to.be.false;
    });

    it("should not remove native token", async function () {
      await expect(settlement.removeSupportedToken(NATIVE))
        .to.be.revertedWith("cannot remove native");
    });

    it("should transfer ownership in two steps (nominate + accept)", async function () {
      const oldOwner = await settlement.owner();

      // Step 1: nomination alone must NOT move ownership (typo-safety).
      await settlement.transferOwnership(user1.address);
      expect(await settlement.owner()).to.equal(oldOwner);
      expect(await settlement.pendingOwner()).to.equal(user1.address);

      // A random address cannot accept someone else's nomination.
      await expect(settlement.connect(user2).acceptOwnership())
        .to.be.revertedWith("not pending owner");

      // A mistyped nomination is recoverable: the owner just re-nominates.
      await settlement.transferOwnership(user2.address);
      expect(await settlement.pendingOwner()).to.equal(user2.address);
      await settlement.transferOwnership(user1.address);

      // Step 2: the nominee accepts and ownership actually moves.
      await settlement.connect(user1).acceptOwnership();
      expect(await settlement.owner()).to.equal(user1.address);
      expect(await settlement.pendingOwner()).to.equal(ethers.ZeroAddress);

      // Old owner can't call admin functions anymore
      await expect(settlement.setPlatformFee(100))
        .to.be.revertedWith("not owner");
    });

    it("receive() must honor the deposit pause (no bare-transfer bypass)", async function () {
      // Normal: a bare transfer credits like depositFIL.
      await user1.sendTransaction({ to: await settlement.getAddress(), value: ethers.parseEther("1") });
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("1"));

      // Paused: depositFIL AND the bare transfer must both refuse new funds.
      await settlement.pause();
      await expect(settlement.connect(user1).depositFIL({ value: ethers.parseEther("1") }))
        .to.be.revertedWith("paused");
      await expect(user1.sendTransaction({ to: await settlement.getAddress(), value: ethers.parseEther("1") }))
        .to.be.revertedWith("paused");
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("1"));
    });

    it("should reject admin calls from non-owner", async function () {
      await expect(settlement.connect(user1).setPlatformFee(100))
        .to.be.revertedWith("not owner");
      await expect(settlement.connect(user1).addSupportedToken(ethers.Wallet.createRandom().address))
        .to.be.revertedWith("not owner");
    });
  });

  // ==================== Edge Cases ====================

  describe("Edge Cases", function () {
    it("should handle zero-fee settlement correctly", async function () {
      await settlement.setPlatformFee(0);
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });

      const amount = ethers.parseEther("5");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("zero-fee"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [amount], [NATIVE], detailsHash
      );

      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(amount);
      expect(await settlement.platformEarnings(NATIVE)).to.equal(0);
    });

    it("should handle max batch size", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("1000") });

      const batchSize = 100;
      const users = Array(batchSize).fill(user1.address);
      const sps = Array(batchSize).fill(sp1.address);
      const amounts = Array(batchSize).fill(ethers.parseEther("1"));
      const tokens = Array(batchSize).fill(NATIVE);
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("max-batch"));

      await settlement.submitSettlement(users, sps, amounts, tokens, detailsHash);

      const record = await settlement.getSettlement(1);
      expect(record.settledCount).to.equal(batchSize);
    });

    it("should reject batch exceeding max size", async function () {
      const batchSize = 101;
      const users = Array(batchSize).fill(user1.address);
      const sps = Array(batchSize).fill(sp1.address);
      const amounts = Array(batchSize).fill(1);
      const tokens = Array(batchSize).fill(NATIVE);
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("too-big"));

      await expect(settlement.submitSettlement(users, sps, amounts, tokens, detailsHash))
        .to.be.revertedWith("invalid batch size");
    });

    it("should handle multi-token settlement in one batch", async function () {
      const tokenAddr = await mockToken.getAddress();

      // User1 deposits both FIL and USDC
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      await mockToken.connect(user1).approve(await settlement.getAddress(), ethers.parseUnits("100", 6));
      await settlement.connect(user1).depositToken(tokenAddr, ethers.parseUnits("100", 6));

      // Settle: FIL and USDC in same batch
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("multi-token"));
      await settlement.submitSettlement(
        [user1.address, user1.address],
        [sp1.address, sp1.address],
        [ethers.parseEther("3"), ethers.parseUnits("50", 6)],
        [NATIVE, tokenAddr],
        detailsHash
      );

      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("7"));
      expect(await settlement.getUserBalance(user1.address, tokenAddr)).to.equal(ethers.parseUnits("50", 6));
    });

    it("should increment settlement nonce correctly", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });

      for (let i = 1; i <= 3; i++) {
        const detailsHash = ethers.keccak256(ethers.toUtf8Bytes(`nonce-${i}`));
        await settlement.submitSettlement(
          [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], detailsHash
        );
        expect(await settlement.settlementNonce()).to.equal(i);
      }
    });
  });

  // ==================== Reentrancy ====================

  describe("Reentrancy", function () {
    let ReentrantAttacker;

    beforeEach(async function () {
      ReentrantAttacker = await ethers.getContractFactory("ReentrantAttacker");
    });

    it("should block reentrancy on withdrawEarnings (SP is a malicious contract)", async function () {
      const attacker = await ReentrantAttacker.deploy(await settlement.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // user funds the contract; settle crediting the attacker as the SP
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("reentry-withdraw"));
      await settlement.submitSettlement(
        [user1.address], [attackerAddr], [ethers.parseEther("10")], [NATIVE], detailsHash
      );
      const earnings = ethers.parseEther("10") - (ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n);

      await attacker.setMode(1, 0);
      await attacker.triggerWithdraw(NATIVE);

      expect(await attacker.reentryReverted()).to.be.true;       // re-entrant call was rejected
      expect(await attacker.reentrySuccesses()).to.equal(0);     // no double withdrawal
      expect(await attacker.lastError()).to.not.equal("0x");      // an actual revert payload
      expect(await settlement.getSPEarnings(attackerAddr, NATIVE)).to.equal(0); // zeroed once
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(earnings); // received exactly once
    });

    it("should block reentrancy on claimRefund (user is a malicious contract)", async function () {
      const attacker = await ReentrantAttacker.deploy(await settlement.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      await attacker.depositFIL({ value: ethers.parseEther("10") });
      await attacker.doRequestRefund(NATIVE, ethers.parseEther("5")); // requestId = 1
      await attacker.setMode(2, 1);
      await time.increase(REFUND_DELAY + 1);

      await attacker.triggerClaim(1);

      expect(await attacker.reentryReverted()).to.be.true;
      expect(await attacker.reentrySuccesses()).to.equal(0);
      const req = await settlement.getRefundRequest(1);
      expect(req.claimed).to.be.true;                              // claimed exactly once
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(ethers.parseEther("5"));
      // remaining (un-refunded) balance still held in the contract
      expect(await settlement.getUserBalance(attackerAddr, NATIVE)).to.equal(ethers.parseEther("5"));
    });

    it("should block reentrancy on withdrawPlatformEarnings (owner is a malicious contract)", async function () {
      const attacker = await ReentrantAttacker.deploy(await settlement.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("reentry-platform"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("10")], [NATIVE], detailsHash
      );
      const fee = ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n;
      // hand ownership to the attacker so its re-entrant call passes onlyOwner and hits
      // the guard (two-step: nominate, then the attacker contract accepts)
      await settlement.transferOwnership(attackerAddr);
      await attacker.acceptOwner();

      await attacker.setMode(3, 0);
      await attacker.triggerPlatformWithdraw(NATIVE);

      expect(await attacker.reentryReverted()).to.be.true;
      expect(await attacker.reentrySuccesses()).to.equal(0);
      expect(await settlement.platformEarnings(NATIVE)).to.equal(0);  // zeroed once
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(fee); // received exactly once
    });

    it("submitSettlement has no external-call reentrancy vector (credit is pull-based)", async function () {
      // Crediting an SP does NOT transfer funds — earnings accrue and are withdrawn later.
      // So submitSettlement never calls into the SP and its nonReentrant guard is pure
      // defense-in-depth with no triggerable callback. Prove credit != transfer.
      const attacker = await ReentrantAttacker.deploy(await settlement.getAddress());
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("no-vector"));
      await settlement.submitSettlement(
        [user1.address], [attackerAddr], [ethers.parseEther("10")], [NATIVE], detailsHash
      );

      // attacker received NO native FIL during settlement (receive() never fired)
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(0);
      expect(await attacker.reentryReverted()).to.be.false;
      // but it DOES have a (pull-based) earnings credit it can later withdraw
      const earnings = ethers.parseEther("10") - (ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n);
      expect(await settlement.getSPEarnings(attackerAddr, NATIVE)).to.equal(earnings);
    });
  });

  // ==================== Native (FIL) transfer failure ====================

  describe("Native transfer failure", function () {
    let RejectingReceiver;

    beforeEach(async function () {
      RejectingReceiver = await ethers.getContractFactory("RejectingReceiver");
    });

    it("withdrawEarnings reverts and rolls back when SP rejects native FIL", async function () {
      const rej = await RejectingReceiver.deploy(await settlement.getAddress());
      await rej.waitForDeployment();
      const rejAddr = await rej.getAddress();

      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("reject-withdraw"));
      await settlement.submitSettlement(
        [user1.address], [rejAddr], [ethers.parseEther("10")], [NATIVE], detailsHash
      );
      const earnings = ethers.parseEther("10") - (ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n);

      await expect(rej.withdraw(NATIVE)).to.be.revertedWith("FIL transfer failed");

      // state rolled back: earnings NOT zeroed, no FIL stuck in the rejecter
      expect(await settlement.getSPEarnings(rejAddr, NATIVE)).to.equal(earnings);
      expect(await ethers.provider.getBalance(rejAddr)).to.equal(0);
    });

    it("claimRefund reverts and rolls back when user rejects native FIL", async function () {
      const rej = await RejectingReceiver.deploy(await settlement.getAddress());
      await rej.waitForDeployment();
      const rejAddr = await rej.getAddress();

      await rej.depositFIL({ value: ethers.parseEther("10") });
      await rej.doRequestRefund(NATIVE, ethers.parseEther("5")); // requestId = 1
      await time.increase(REFUND_DELAY + 1);

      await expect(rej.claim(1)).to.be.revertedWith("FIL transfer failed");

      // state rolled back: refund still claimable, full deposit preserved (request
      // only locked, never deducted, so the failed claim leaves the balance intact)
      const req = await settlement.getRefundRequest(1);
      expect(req.claimed).to.be.false;
      expect(await settlement.getUserBalance(rejAddr, NATIVE)).to.equal(ethers.parseEther("10"));
      expect(await ethers.provider.getBalance(rejAddr)).to.equal(0);
    });
  });

  // ==================== Platform withdrawal (full coverage) ====================

  describe("Platform withdrawal (full coverage)", function () {
    async function settleFIL(amount) {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("pw-" + amount));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther(amount)], [NATIVE], detailsHash
      );
    }

    it("rejects withdrawPlatformEarnings from non-owner", async function () {
      await expect(settlement.connect(user1).withdrawPlatformEarnings(NATIVE, user1.address))
        .to.be.revertedWith("not owner");
    });

    it("rejects withdraw to the zero address", async function () {
      await settleFIL("10"); // give it earnings so we don't trip 'no earnings' first
      await expect(settlement.withdrawPlatformEarnings(NATIVE, ethers.ZeroAddress))
        .to.be.revertedWith("invalid address");
    });

    it("rejects withdraw when there are no platform earnings", async function () {
      await expect(settlement.withdrawPlatformEarnings(NATIVE, platformWallet.address))
        .to.be.revertedWith("no earnings");
    });

    it("zeroes platformEarnings after a FIL withdrawal", async function () {
      await settleFIL("10");
      const fee = ethers.parseEther("10") * BigInt(FEE_BPS) / 10000n;
      expect(await settlement.platformEarnings(NATIVE)).to.equal(fee);

      await expect(settlement.withdrawPlatformEarnings(NATIVE, platformWallet.address))
        .to.emit(settlement, "PlatformWithdrawn")
        .withArgs(platformWallet.address, NATIVE, fee);

      // re-read: must be zeroed (guards against a double-withdraw drain)
      expect(await settlement.platformEarnings(NATIVE)).to.equal(0);
      await expect(settlement.withdrawPlatformEarnings(NATIVE, platformWallet.address))
        .to.be.revertedWith("no earnings");
    });

    it("withdraws ERC20 platform earnings and zeroes them", async function () {
      const tokenAddr = await mockToken.getAddress();
      const depositAmt = ethers.parseUnits("500", 6);
      await mockToken.connect(user1).approve(await settlement.getAddress(), depositAmt);
      await settlement.connect(user1).depositToken(tokenAddr, depositAmt);

      const settleAmt = ethers.parseUnits("100", 6);
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("pw-erc20"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [settleAmt], [tokenAddr], detailsHash
      );
      const fee = settleAmt * BigInt(FEE_BPS) / 10000n;

      await settlement.withdrawPlatformEarnings(tokenAddr, platformWallet.address);

      expect(await mockToken.balanceOf(platformWallet.address)).to.equal(fee);
      expect(await settlement.platformEarnings(tokenAddr)).to.equal(0);
    });
  });

  // ==================== Refund — cancel guards + ERC20 claim ====================

  describe("Refund extra coverage", function () {
    const depositAmount = ethers.parseEther("10");

    beforeEach(async function () {
      await settlement.connect(user1).depositFIL({ value: depositAmount });
    });

    it("rejects cancelRefund from a non-owner of the request", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await expect(settlement.connect(user2).cancelRefund(1))
        .to.be.revertedWith("not your request");
    });

    it("rejects cancelRefund after the refund was claimed", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      await time.increase(REFUND_DELAY + 1);
      await settlement.connect(user1).claimRefund(1);
      await expect(settlement.connect(user1).cancelRefund(1))
        .to.be.revertedWith("already claimed");
    });

    it("rejects double-cancel and does NOT double-credit the balance", async function () {
      await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      // first cancel restores balance to full
      await settlement.connect(user1).cancelRefund(1);
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
      // second cancel must revert (else balance would inflate to 15 = free money)
      await expect(settlement.connect(user1).cancelRefund(1))
        .to.be.revertedWith("already cancelled");
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(depositAmount);
    });

    it("claims an ERC20 refund after the timelock", async function () {
      const tokenAddr = await mockToken.getAddress();
      const depositAmt = ethers.parseUnits("100", 6);
      await mockToken.connect(user1).approve(await settlement.getAddress(), depositAmt);
      await settlement.connect(user1).depositToken(tokenAddr, depositAmt);

      const before = await mockToken.balanceOf(user1.address);
      const refundAmt = ethers.parseUnits("40", 6);
      await settlement.connect(user1).requestRefund(tokenAddr, refundAmt);
      await time.increase(REFUND_DELAY + 1);
      await settlement.connect(user1).claimRefund(1);

      expect(await mockToken.balanceOf(user1.address)).to.equal(before + refundAmt);
      expect(await settlement.getUserBalance(user1.address, tokenAddr)).to.equal(depositAmt - refundAmt);
    });
  });

  // ==================== Token whitelist guards ====================

  describe("Token whitelist guards", function () {
    it("rejects addSupportedToken for the native token", async function () {
      await expect(settlement.addSupportedToken(NATIVE))
        .to.be.revertedWith("native always supported");
    });

    it("rejects adding an already-supported token", async function () {
      const tokenAddr = await mockToken.getAddress(); // already whitelisted in fixture
      await expect(settlement.addSupportedToken(tokenAddr))
        .to.be.revertedWith("already supported");
    });

    it("rejects removeSupportedToken from a non-owner", async function () {
      const tokenAddr = await mockToken.getAddress();
      await expect(settlement.connect(user1).removeSupportedToken(tokenAddr))
        .to.be.revertedWith("not owner");
    });

    it("rejects removing a token that is not supported", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(settlement.removeSupportedToken(fakeToken))
        .to.be.revertedWith("not supported");
    });
  });

  // ==================== Low-risk completeness ====================

  describe("Low-risk completeness", function () {
    it("rejects deploying with a fee above the cap", async function () {
      const F = await ethers.getContractFactory("OpenModelSettlement");
      await expect(F.deploy(3001, REFUND_DELAY)).to.be.revertedWith("fee too high");
      // boundary: exactly MAX_FEE_BPS is allowed
      const ok = await F.deploy(3000, REFUND_DELAY);
      await ok.waitForDeployment();
      expect(await ok.platformFeeBps()).to.equal(3000);
    });

    it("rejects a zero-amount refund request", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      await expect(settlement.connect(user1).requestRefund(NATIVE, 0))
        .to.be.revertedWith("zero amount");
    });

    it("rejects setRefundDelay from a non-owner and updates state for owner", async function () {
      await expect(settlement.connect(user1).setRefundDelay(7200))
        .to.be.revertedWith("not owner");
      await settlement.setRefundDelay(7200);
      expect(await settlement.refundDelaySec()).to.equal(7200);
    });

    it("rejects transferring ownership to the zero address", async function () {
      await expect(settlement.transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWith("invalid address");
      // owner unchanged
      expect(await settlement.owner()).to.equal(owner.address);
    });

    it("exposes a refund request via getRefundRequest", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      const tx = await settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("5"));
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const req = await settlement.getRefundRequest(1);
      expect(req.user).to.equal(user1.address);
      expect(req.token).to.equal(NATIVE);
      expect(req.amount).to.equal(ethers.parseEther("5"));
      expect(req.claimableAt).to.equal(BigInt(block.timestamp) + BigInt(REFUND_DELAY));
      expect(req.claimed).to.be.false;
      expect(req.cancelled).to.be.false;
    });

    it("emits SettlementExecuted with the correct platformFee arg", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("100") });
      const amount = ethers.parseEther("10");
      const fee = amount * BigInt(FEE_BPS) / 10000n;
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("evt-args"));
      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [amount], [NATIVE], detailsHash
      )).to.emit(settlement, "SettlementExecuted")
        .withArgs(1, amount, fee, 1, 0, detailsHash);
    });

    it("floors the fee and conserves value (no wei lost or created)", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("1") });
      // 333 wei * 500 / 10000 = 16.65 -> floors to 16; SP gets the 317 remainder
      const amount = 333n;
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("rounding"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [amount], [NATIVE], detailsHash
      );
      const fee = await settlement.platformEarnings(NATIVE);
      const spAmount = await settlement.getSPEarnings(sp1.address, NATIVE);
      expect(fee).to.equal(16n);          // floored, not 17
      expect(spAmount).to.equal(317n);
      expect(fee + spAmount).to.equal(amount); // conservation
    });

    it("rejects array-length mismatch on amounts and on tokens", async function () {
      // amounts too short
      await expect(settlement.submitSettlement(
        [user1.address, user2.address], [sp1.address, sp2.address],
        [ethers.parseEther("1")], [NATIVE, NATIVE],
        ethers.keccak256(ethers.toUtf8Bytes("mm-amounts"))
      )).to.be.revertedWith("array length mismatch");
      // tokens too short
      await expect(settlement.submitSettlement(
        [user1.address, user2.address], [sp1.address, sp2.address],
        [ethers.parseEther("1"), ethers.parseEther("1")], [NATIVE],
        ethers.keccak256(ethers.toUtf8Bytes("mm-tokens"))
      )).to.be.revertedWith("array length mismatch");
    });

    it("handles the same user+token twice in one batch (sequential drawdown)", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      // two 6-FIL items for the same (user, token): first succeeds (10->4), second must
      // see the decremented balance (4 < 6) and be skipped.
      const six = ethers.parseEther("6");
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("same-user-twice"));
      const tx = await settlement.submitSettlement(
        [user1.address, user1.address], [sp1.address, sp1.address],
        [six, six], [NATIVE, NATIVE], detailsHash
      );
      await expect(tx).to.emit(settlement, "SettlementItemFailed")
        .withArgs(1, 1, user1.address, "insufficient balance");

      const record = await settlement.getSettlement(1);
      expect(record.settledCount).to.equal(1);
      expect(record.failedCount).to.equal(1);
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("4"));
      const fee = six * BigInt(FEE_BPS) / 10000n;
      expect(await settlement.getSPEarnings(sp1.address, NATIVE)).to.equal(six - fee);
    });

    it("rejects depositToken without prior approval", async function () {
      const tokenAddr = await mockToken.getAddress(); // user1 has tokens minted, not approved
      await expect(settlement.connect(user1).depositToken(tokenAddr, ethers.parseUnits("10", 6)))
        .to.be.reverted; // SafeERC20: insufficient allowance (custom error)
    });
  });

  // ==================== Audit medium fixes ====================

  describe("Audit medium fixes", function () {
    it("setRefundDelay rejects a delay above MAX_REFUND_DELAY", async function () {
      const tooLong = 31 * 24 * 60 * 60; // 31 days > 30-day cap
      await expect(settlement.setRefundDelay(tooLong)).to.be.revertedWith("refund delay too long");
      await expect(settlement.setRefundDelay(7 * 24 * 60 * 60)).to.not.be.reverted; // 7 days OK
    });

    it("submitSettlement skips a zero-address SP instead of burning funds", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      const detailsHash = ethers.keccak256(ethers.toUtf8Bytes("zero-sp"));
      await settlement.submitSettlement(
        [user1.address], [ethers.ZeroAddress], [ethers.parseEther("3")], [NATIVE], detailsHash
      );
      const rec = await settlement.getSettlement(1);
      expect(rec.settledCount).to.equal(0);
      expect(rec.failedCount).to.equal(1);
      // user NOT charged; nothing credited to the black-hole address
      expect(await settlement.getUserBalance(user1.address, NATIVE)).to.equal(ethers.parseEther("10"));
      expect(await settlement.getSPEarnings(ethers.ZeroAddress, NATIVE)).to.equal(0);
    });

    it("depositToken credits the ACTUAL received amount for a fee-on-transfer token", async function () {
      const Fee = await ethers.getContractFactory("FeeOnTransferToken");
      const fee = await Fee.deploy();
      await fee.waitForDeployment();
      const feeAddr = await fee.getAddress();
      await settlement.addSupportedToken(feeAddr);
      await fee.mint(user1.address, ethers.parseEther("100"));
      await fee.connect(user1).approve(await settlement.getAddress(), ethers.parseEther("100"));

      // Deposit 100; the token burns 10% on transfer, so the contract receives 90.
      await expect(settlement.connect(user1).depositToken(feeAddr, ethers.parseEther("100")))
        .to.emit(settlement, "Deposited")
        .withArgs(user1.address, feeAddr, ethers.parseEther("90"));
      // Books reflect 90 (real holdings), not the requested 100.
      expect(await settlement.getUserBalance(user1.address, feeAddr)).to.equal(ethers.parseEther("90"));
      expect(await fee.balanceOf(await settlement.getAddress())).to.equal(ethers.parseEther("90"));
    });
  });

  // ==================== Operator role (settler/owner separation) ====================
  describe("Operator role", function () {
    it("defaults the operator to the deployer", async function () {
      expect(await settlement.operator()).to.equal(owner.address);
    });

    it("lets the owner set/rotate the operator and emits OperatorUpdated", async function () {
      await expect(settlement.setOperator(sp2.address))
        .to.emit(settlement, "OperatorUpdated").withArgs(owner.address, sp2.address);
      expect(await settlement.operator()).to.equal(sp2.address);
    });

    it("rejects setOperator from a non-owner and a zero address", async function () {
      await expect(settlement.connect(user1).setOperator(sp2.address)).to.be.revertedWith("not owner");
      await expect(settlement.setOperator(ethers.ZeroAddress)).to.be.revertedWith("invalid operator");
    });

    it("after handoff, only the operator settles and the owner keeps admin but cannot settle", async function () {
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      await settlement.setOperator(sp2.address); // hand settlement to a dedicated key
      const h = ethers.keccak256(ethers.toUtf8Bytes("byOperator"));
      // owner is no longer the operator → cannot settle
      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], h
      )).to.be.revertedWith("not operator");
      // the designated operator can
      await expect(settlement.connect(sp2).submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], h
      )).to.emit(settlement, "SettlementExecuted");
      // owner still holds admin powers (e.g. fee) despite giving up settling
      await expect(settlement.setPlatformFee(100)).to.emit(settlement, "PlatformFeeUpdated");
    });
  });

  // ==================== Emergency pause ====================
  describe("Emergency pause", function () {
    it("lets only the owner pause/unpause, with correct events and double-toggle guards", async function () {
      await expect(settlement.connect(user1).pause()).to.be.revertedWith("not owner");
      await expect(settlement.pause()).to.emit(settlement, "Paused").withArgs(owner.address);
      expect(await settlement.paused()).to.equal(true);
      await expect(settlement.pause()).to.be.revertedWith("already paused");
      await expect(settlement.connect(user1).unpause()).to.be.revertedWith("not owner");
      await expect(settlement.unpause()).to.emit(settlement, "Unpaused").withArgs(owner.address);
      expect(await settlement.paused()).to.equal(false);
      await expect(settlement.unpause()).to.be.revertedWith("not paused");
    });

    it("halts deposits and settlement while paused", async function () {
      await settlement.pause();
      await expect(settlement.connect(user1).depositFIL({ value: ethers.parseEther("1") }))
        .to.be.revertedWith("paused");
      const tokenAddr = await mockToken.getAddress();
      await mockToken.connect(user1).approve(await settlement.getAddress(), ethers.parseUnits("100", 6));
      await expect(settlement.connect(user1).depositToken(tokenAddr, ethers.parseUnits("100", 6)))
        .to.be.revertedWith("paused");
      const h = ethers.keccak256(ethers.toUtf8Bytes("whilePaused"));
      await expect(settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("1")], [NATIVE], h
      )).to.be.revertedWith("paused");
    });

    it("keeps refunds and SP withdrawals OPEN while paused (funds never trapped)", async function () {
      // deposit + settle so user1 keeps a balance and sp1 has earnings
      await settlement.connect(user1).depositFIL({ value: ethers.parseEther("10") });
      const h = ethers.keccak256(ethers.toUtf8Bytes("preP"));
      await settlement.submitSettlement(
        [user1.address], [sp1.address], [ethers.parseEther("4")], [NATIVE], h
      );
      await settlement.pause();
      // user can still request + claim a refund (after the timelock)
      await expect(settlement.connect(user1).requestRefund(NATIVE, ethers.parseEther("2")))
        .to.emit(settlement, "RefundRequested");
      await time.increase(REFUND_DELAY + 1);
      await expect(settlement.connect(user1).claimRefund(1)).to.emit(settlement, "RefundClaimed");
      // sp can still withdraw its earnings
      await expect(settlement.connect(sp1).withdrawEarnings(NATIVE)).to.emit(settlement, "SPWithdrawn");
    });
  });
});
