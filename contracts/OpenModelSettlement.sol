// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract OpenModelSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---
    uint256 public constant MAX_FEE_BPS = 3000; // 30%
    uint256 public constant MAX_BATCH_SIZE = 100;
    uint256 public constant MAX_REFUND_DELAY = 30 days; // bound on setRefundDelay
    address public constant NATIVE_TOKEN = address(0); // FIL

    // --- State ---
    address public owner;
    // Two-step ownership transfer: transferOwnership only NOMINATES; the new owner must
    // acceptOwnership from its own key. A typo'd address therefore cannot permanently
    // brick the owner role (fee changes, pause, operator rotation, platform withdrawal).
    address public pendingOwner;
    // operator is a LOW-PRIVILEGE settler role: it can ONLY submitSettlement (and only
    // when not paused). This is the hot key that lives on the online gateway. Keeping it
    // separate from owner means a leaked settlement key cannot change fees, drain platform
    // earnings, or take over the contract — owner (cold/multisig) retains all of that.
    address public operator;
    // Emergency stop. When true, deposits and settlement are halted; refunds and
    // withdrawals stay OPEN so user/SP funds can always be pulled out (no fund trapping).
    bool public paused;
    uint256 public platformFeeBps; // e.g., 500 = 5%

    // user → token → balance
    mapping(address => mapping(address => uint256)) public balances;
    // sp → token → earnings
    mapping(address => mapping(address => uint256)) public spEarnings;
    // token → platform earnings
    mapping(address => uint256) public platformEarnings;
    // whitelist
    mapping(address => bool) public supportedTokens;

    // Settlement tracking
    uint256 public settlementNonce;
    mapping(uint256 => SettlementRecord) public settlements;
    mapping(bytes32 => bool) public processedBatches;

    // Refund timelock
    uint256 public refundDelaySec;
    uint256 public refundNonce;
    mapping(uint256 => RefundRequest) public refundRequests;
    // user → token → amount locked by pending (unclaimed, uncancelled) refund
    // requests. Refunds LOCK free balance but only DEDUCT it at claim time, so
    // settlement keeps priority within the timelock window (audit HIGH fix:
    // requesting a refund can no longer be used to dodge a pending settlement).
    mapping(address => mapping(address => uint256)) public lockedForRefund;

    // --- Structs ---
    struct SettlementRecord {
        uint256 batchId;
        uint256 timestamp;
        uint256 totalAmount;
        uint256 settledCount;
        uint256 failedCount;
        bytes32 detailsHash;
    }

    struct RefundRequest {
        address user;
        address token;
        uint256 amount;
        uint256 claimableAt;
        bool claimed;
        bool cancelled;
    }

    // --- Events ---
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event RefundRequested(uint256 indexed requestId, address indexed user, address indexed token, uint256 amount, uint256 claimableAt);
    event RefundClaimed(uint256 indexed requestId, address indexed user, address indexed token, uint256 amount);
    event RefundCancelled(uint256 indexed requestId, address indexed user);
    event SettlementExecuted(uint256 indexed batchId, uint256 totalAmount, uint256 platformFee, uint256 settledCount, uint256 failedCount, bytes32 detailsHash);
    event SettlementItemFailed(uint256 indexed batchId, uint256 index, address user, string reason);
    event SPWithdrawn(address indexed sp, address indexed token, uint256 amount);
    event PlatformWithdrawn(address indexed to, address indexed token, uint256 amount);
    event PlatformFeeUpdated(uint256 oldBps, uint256 newBps);
    event RefundDelayUpdated(uint256 oldDelay, uint256 newDelay);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event OwnerTransferProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnerTransferred(address indexed oldOwner, address indexed newOwner);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    // --- Constructor ---
    constructor(uint256 _platformFeeBps, uint256 _refundDelaySec) {
        require(_platformFeeBps <= MAX_FEE_BPS, "fee too high");
        owner = msg.sender;
        operator = msg.sender; // deployer settles until owner assigns a dedicated operator
        platformFeeBps = _platformFeeBps;
        refundDelaySec = _refundDelaySec;
        // Native FIL is always supported
        supportedTokens[NATIVE_TOKEN] = true;
    }

    // ==================== User Functions ====================

    function depositFIL() external payable whenNotPaused {
        require(msg.value > 0, "zero deposit");
        balances[msg.sender][NATIVE_TOKEN] += msg.value;
        emit Deposited(msg.sender, NATIVE_TOKEN, msg.value);
    }

    function depositToken(address token, uint256 amount) external whenNotPaused {
        require(token != NATIVE_TOKEN, "use depositFIL for native");
        require(supportedTokens[token], "token not supported");
        require(amount > 0, "zero deposit");
        // Credit the ACTUAL amount received (balance diff), not the requested amount,
        // so a fee-on-transfer / rebasing token cannot make the books exceed real
        // holdings and let withdrawals drain other users (audit MEDIUM fix). A
        // standard ERC20 credits exactly `amount`.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        require(received > 0, "no tokens received");
        balances[msg.sender][token] += received;
        emit Deposited(msg.sender, token, received);
    }

    function requestRefund(address token, uint256 amount) external returns (uint256 requestId) {
        require(amount > 0, "zero amount");
        // Lock free balance (balance not already locked by other pending refunds)
        // but do NOT deduct it — settlement still draws from the full balance
        // during the timelock window, defeating the front-running free-rider.
        uint256 bal = balances[msg.sender][token];
        uint256 locked = lockedForRefund[msg.sender][token];
        require(bal >= locked && bal - locked >= amount, "insufficient free balance");

        lockedForRefund[msg.sender][token] = locked + amount;
        requestId = ++refundNonce;
        uint256 claimableAt = block.timestamp + refundDelaySec;
        refundRequests[requestId] = RefundRequest({
            user: msg.sender,
            token: token,
            amount: amount,
            claimableAt: claimableAt,
            claimed: false,
            cancelled: false
        });
        emit RefundRequested(requestId, msg.sender, token, amount, claimableAt);
    }

    function claimRefund(uint256 requestId) external nonReentrant {
        RefundRequest storage req = refundRequests[requestId];
        require(req.user == msg.sender, "not your request");
        require(!req.claimed, "already claimed");
        require(!req.cancelled, "cancelled");
        require(block.timestamp >= req.claimableAt, "too early");
        // Funds may have been consumed by settlement during the timelock window.
        // Only what is still on balance can be refunded; otherwise the user spent
        // it and should cancelRefund to release the (now meaningless) lock.
        require(balances[req.user][req.token] >= req.amount, "balance already settled");

        req.claimed = true;
        balances[req.user][req.token] -= req.amount;
        lockedForRefund[req.user][req.token] -= req.amount;
        _transferOut(req.token, msg.sender, req.amount);
        emit RefundClaimed(requestId, msg.sender, req.token, req.amount);
    }

    function cancelRefund(uint256 requestId) external {
        RefundRequest storage req = refundRequests[requestId];
        require(req.user == msg.sender, "not your request");
        require(!req.claimed, "already claimed");
        require(!req.cancelled, "already cancelled");

        req.cancelled = true;
        // Balance was never deducted on request — just release the lock.
        lockedForRefund[req.user][req.token] -= req.amount;
        emit RefundCancelled(requestId, msg.sender);
    }

    // ==================== Operator Functions ====================

    function submitSettlement(
        address[] calldata users,
        address[] calldata sps,
        uint256[] calldata amounts,
        address[] calldata tokens,
        bytes32 detailsHash
    ) external onlyOperator whenNotPaused nonReentrant {
        uint256 len = users.length;
        require(len > 0 && len <= MAX_BATCH_SIZE, "invalid batch size");
        require(len == sps.length && len == amounts.length && len == tokens.length, "array length mismatch");
        require(!processedBatches[detailsHash], "batch already processed");

        processedBatches[detailsHash] = true;
        uint256 batchId = ++settlementNonce;

        uint256 totalAmount;
        uint256 totalFee;
        uint256 settledCount;
        uint256 failedCount;

        for (uint256 i = 0; i < len; i++) {
            // Refuse a zero SP address: crediting earnings to address(0) is an
            // operator-misconfig black hole (unwithdrawable). Skip the item (don't
            // charge the user) instead of silently burning funds (audit fix).
            if (sps[i] == address(0)) {
                failedCount++;
                emit SettlementItemFailed(batchId, i, users[i], "zero sp address");
                continue;
            }
            if (balances[users[i]][tokens[i]] < amounts[i]) {
                failedCount++;
                emit SettlementItemFailed(batchId, i, users[i], "insufficient balance");
                continue;
            }

            uint256 fee = (amounts[i] * platformFeeBps) / 10000;
            uint256 spAmount = amounts[i] - fee;

            balances[users[i]][tokens[i]] -= amounts[i];
            spEarnings[sps[i]][tokens[i]] += spAmount;
            platformEarnings[tokens[i]] += fee;
            totalAmount += amounts[i];
            totalFee += fee;
            settledCount++;
        }

        settlements[batchId] = SettlementRecord({
            batchId: batchId,
            timestamp: block.timestamp,
            totalAmount: totalAmount,
            settledCount: settledCount,
            failedCount: failedCount,
            detailsHash: detailsHash
        });

        emit SettlementExecuted(batchId, totalAmount, totalFee, settledCount, failedCount, detailsHash);
    }

    // ==================== SP Functions ====================

    function withdrawEarnings(address token) external nonReentrant {
        uint256 amount = spEarnings[msg.sender][token];
        require(amount > 0, "no earnings");
        spEarnings[msg.sender][token] = 0;
        _transferOut(token, msg.sender, amount);
        emit SPWithdrawn(msg.sender, token, amount);
    }

    // ==================== Platform/Owner Functions ====================

    function withdrawPlatformEarnings(address token, address to) external onlyOwner nonReentrant {
        require(to != address(0), "invalid address");
        uint256 amount = platformEarnings[token];
        require(amount > 0, "no earnings");
        platformEarnings[token] = 0;
        _transferOut(token, to, amount);
        emit PlatformWithdrawn(to, token, amount);
    }

    function addSupportedToken(address token) external onlyOwner {
        require(token != NATIVE_TOKEN, "native always supported");
        require(!supportedTokens[token], "already supported");
        supportedTokens[token] = true;
        emit TokenAdded(token);
    }

    function removeSupportedToken(address token) external onlyOwner {
        require(token != NATIVE_TOKEN, "cannot remove native");
        require(supportedTokens[token], "not supported");
        supportedTokens[token] = false;
        emit TokenRemoved(token);
    }

    function setPlatformFee(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "fee too high");
        uint256 oldBps = platformFeeBps;
        platformFeeBps = newBps;
        emit PlatformFeeUpdated(oldBps, newBps);
    }

    function setRefundDelay(uint256 newDelay) external onlyOwner {
        require(newDelay <= MAX_REFUND_DELAY, "refund delay too long");
        uint256 oldDelay = refundDelaySec;
        refundDelaySec = newDelay;
        emit RefundDelayUpdated(oldDelay, newDelay);
    }

    // Step 1 of 2: nominate a new owner. Ownership does NOT move until the nominee
    // calls acceptOwnership, so a mistyped address is recoverable (re-nominate).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "invalid address");
        pendingOwner = newOwner;
        emit OwnerTransferProposed(owner, newOwner);
    }

    // Step 2 of 2: the nominee claims ownership, proving control of the new key.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address oldOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerTransferred(oldOwner, owner);
    }

    // Assign/rotate the low-privilege settler. Owner keeps this power so a compromised
    // or lost operator key can be replaced without touching user funds.
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "invalid operator");
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    // Emergency stop: halts deposits + settlement. Refunds and withdrawals stay open
    // (whenNotPaused is intentionally NOT applied to them) so funds are never trapped.
    function pause() external onlyOwner {
        require(!paused, "already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ==================== View Functions ====================

    function getUserBalance(address user, address token) external view returns (uint256) {
        return balances[user][token];
    }

    function getSPEarnings(address sp, address token) external view returns (uint256) {
        return spEarnings[sp][token];
    }

    function getSettlement(uint256 batchId) external view returns (SettlementRecord memory) {
        return settlements[batchId];
    }

    function getRefundRequest(uint256 requestId) external view returns (RefundRequest memory) {
        return refundRequests[requestId];
    }

    // ==================== Internal ====================

    function _transferOut(address token, address to, uint256 amount) internal {
        if (token == NATIVE_TOKEN) {
            (bool success, ) = to.call{value: amount}("");
            require(success, "FIL transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // Bare FIL transfers credit the sender like depositFIL. whenNotPaused matters here
    // too: without it a plain transfer bypassed the emergency deposit halt (audit fix).
    // NOTE (Filecoin): a native method-0 send to an EVM actor does NOT run EVM code —
    // such funds land on the actor balance UNCREDITED to anyone. Users must deposit via
    // an EVM call (depositFIL or a calldata-less eth transaction), never `lotus send`.
    receive() external payable whenNotPaused {
        balances[msg.sender][NATIVE_TOKEN] += msg.value;
        emit Deposited(msg.sender, NATIVE_TOKEN, msg.value);
    }
}
