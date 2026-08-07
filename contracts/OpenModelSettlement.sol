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
    // ABI schema marker for off-chain clients. v1.2 and earlier deployments have no
    // such getter (the call reverts there), which is exactly how a client verifies it
    // is talking to a stats-capable contract before using the 7-argument
    // submitSettlement or the extended SettlementRecord layout.
    uint256 public constant SCHEMA_VERSION = 3;
    uint256 public constant MAX_REFUND_DELAY = 30 days; // bound on setRefundDelay
    uint256 public constant MAX_EARNINGS_FREEZE = 90 days; // bound on setEarningsFreeze
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
    // arbiter is the QUALITY-ENFORCEMENT role: its ONLY power is moving a provider's
    // still-frozen earnings into the platform pool (confiscateFrozenEarnings) when
    // misreporting / substandard service is proven off-chain. It cannot touch user
    // balances or matured earnings, and cannot route funds to itself (platform
    // withdrawal stays onlyOwner). Like operator, it is a hot key with strictly
    // bounded damage. Defaults to the deployer; owner can rotate it.
    address public arbiter;
    // Emergency stop. When true, deposits and settlement are halted; refunds and
    // withdrawals stay OPEN so user/SP funds can always be pulled out (no fund trapping).
    bool public paused;
    uint256 public platformFeeBps; // e.g., 500 = 5%
    // Earnings freeze window: SP earnings credited by settlement stay locked for this
    // many seconds before they become withdrawable. 0 (default) = no freeze, exact
    // pre-v1.1 behavior. The freeze window doubles as the dispute window: frozen
    // earnings are the provider's de-facto stake and can be confiscated by the
    // arbiter with published evidence while still frozen.
    uint256 public earningsFreezeSec;
    // Lockup bucket granularity: unlock times round UP to the next multiple of
    // freeze/FREEZE_BUCKETS so same-bucket credits merge into one queue entry.
    // Bounds the unmatured queue to ~FREEZE_BUCKETS+1 entries at any settlement
    // cadence; the effective freeze becomes [freeze, freeze*9/8) — a floor, never
    // shortened. See _creditEarnings.
    uint256 private constant FREEZE_BUCKETS = 8;

    // user → token → balance
    mapping(address => mapping(address => uint256)) public balances;
    // sp → token → earnings that have MATURED (are withdrawable now). With
    // earningsFreezeSec == 0 all credits land here directly (pre-v1.1 behavior);
    // with a freeze, credits sit in spLockups first and move here as they mature.
    mapping(address => mapping(address => uint256)) public spEarnings;
    // sp → token → FIFO queue of frozen earnings entries (only written when the
    // freeze is enabled). Entries are consumed from spLockupCursor onward and
    // released strictly in order: a later credit never unlocks before an earlier
    // one, even if earningsFreezeSec was shortened in between.
    mapping(address => mapping(address => EarningsLockup[])) private spLockups;
    // sp → token → index of the first queue entry not yet matured/consumed.
    mapping(address => mapping(address => uint256)) private spLockupCursor;
    // token → platform earnings
    mapping(address => uint256) public platformEarnings;
    // whitelist
    mapping(address => bool) public supportedTokens;

    // Settlement tracking
    uint256 public settlementNonce;
    mapping(uint256 => SettlementRecord) public settlements;
    mapping(bytes32 => bool) public processedBatches;
    // All-time inference volume across every settled batch (settled items only —
    // failed items are excluded and will be counted when their carried debt settles).
    // One eth_call answers "how much inference has this network performed": these are
    // the headline public stats, so they live in dedicated slots rather than being
    // summed over settlement records.
    uint256 public cumulativeRequests;
    uint256 public cumulativeTokens;

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
        // v1.3 batch stats: inference requests and tokens (prompt + completion)
        // covered by the SETTLED items of this batch. Operator-asserted like amounts,
        // but independently checkable: detailsHash commits to one Merkle leaf per
        // request carrying its token counts, so anyone holding the published leaf set
        // can recompute both numbers.
        uint256 requestCount;
        uint256 tokenCount;
    }

    struct RefundRequest {
        address user;
        address token;
        uint256 amount;
        uint256 claimableAt;
        bool claimed;
        bool cancelled;
    }

    struct EarningsLockup {
        uint64 unlockAt;
        uint192 amount; // packs with unlockAt into one slot; far exceeds any real supply
    }

    // --- Events ---
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event RefundRequested(uint256 indexed requestId, address indexed user, address indexed token, uint256 amount, uint256 claimableAt);
    event RefundClaimed(uint256 indexed requestId, address indexed user, address indexed token, uint256 amount);
    event RefundCancelled(uint256 indexed requestId, address indexed user);
    event SettlementExecuted(uint256 indexed batchId, uint256 totalAmount, uint256 platformFee, uint256 settledCount, uint256 failedCount, bytes32 detailsHash, uint256 requestCount, uint256 tokenCount);
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
    event ArbiterUpdated(address indexed oldArbiter, address indexed newArbiter);
    event EarningsFreezeUpdated(uint256 oldSec, uint256 newSec);
    event EarningsConfiscated(address indexed sp, address indexed token, uint256 amount, bytes32 evidenceHash);
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

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "not arbiter");
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
        arbiter = msg.sender; // deployer enforces quality until owner assigns a dedicated arbiter
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

    // requestCounts/tokenCounts are the per-item inference stats (request count and
    // prompt+completion token sum of the requests aggregated into that item). The
    // batch record and the cumulative counters accumulate them for SETTLED items
    // only: a failed item's requests are carried as debt off-chain and re-submitted
    // in a later batch, so counting at submission time would double-count them.
    // detailsHash deliberately does NOT cover these two arrays — it must stay a pure
    // content hash of the economic batch (dedup + crash-replay invariant). They are
    // operator-asserted, verifiable off-chain against the Merkle leaf set committed
    // by detailsHash, and can never move funds.
    function submitSettlement(
        address[] calldata users,
        address[] calldata sps,
        uint256[] calldata amounts,
        address[] calldata tokens,
        uint256[] calldata requestCounts,
        uint256[] calldata tokenCounts,
        bytes32 detailsHash
    ) external onlyOperator whenNotPaused nonReentrant {
        uint256 len = users.length;
        require(len > 0 && len <= MAX_BATCH_SIZE, "invalid batch size");
        require(
            len == sps.length && len == amounts.length && len == tokens.length &&
            len == requestCounts.length && len == tokenCounts.length,
            "array length mismatch"
        );
        require(!processedBatches[detailsHash], "batch already processed");

        processedBatches[detailsHash] = true;
        uint256 batchId = ++settlementNonce;

        uint256 totalAmount;
        uint256 totalFee;
        uint256 settledCount;
        uint256 failedCount;
        uint256 requestCount;
        uint256 tokenCount;

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
            _creditEarnings(sps[i], tokens[i], spAmount);
            platformEarnings[tokens[i]] += fee;
            totalAmount += amounts[i];
            totalFee += fee;
            settledCount++;
            requestCount += requestCounts[i];
            tokenCount += tokenCounts[i];
        }

        cumulativeRequests += requestCount;
        cumulativeTokens += tokenCount;

        settlements[batchId] = SettlementRecord({
            batchId: batchId,
            timestamp: block.timestamp,
            totalAmount: totalAmount,
            settledCount: settledCount,
            failedCount: failedCount,
            detailsHash: detailsHash,
            requestCount: requestCount,
            tokenCount: tokenCount
        });

        emit SettlementExecuted(batchId, totalAmount, totalFee, settledCount, failedCount, detailsHash, requestCount, tokenCount);
    }

    // ==================== SP Functions ====================

    function withdrawEarnings(address token) external nonReentrant {
        _matureLockups(msg.sender, token, 0);
        uint256 amount = spEarnings[msg.sender][token];
        require(amount > 0, "no earnings");
        spEarnings[msg.sender][token] = 0;
        _transferOut(token, msg.sender, amount);
        emit SPWithdrawn(msg.sender, token, amount);
    }

    // Permissionless chunked maturation — an escape hatch in case an SP's lockup
    // queue has grown too long to walk inside a single withdraw. It only ever moves
    // the SP's own matured funds into the SP's own withdrawable bucket.
    function matureEarnings(address sp, address token, uint256 maxEntries) external {
        _matureLockups(sp, token, maxEntries);
    }

    // ==================== Arbiter Functions ====================

    // Seize a misbehaving SP's still-frozen earnings into the platform pool. Matured
    // entries are matured first and are NOT seizable — the freeze window is exactly
    // the dispute window. evidenceHash commits to the published off-chain evidence
    // bundle (retained request/response samples + verdict) justifying the seizure,
    // making every confiscation publicly attributable and auditable. Deliberately
    // callable while paused: an emergency pause must not shield a caught provider
    // until its earnings mature.
    function confiscateFrozenEarnings(address sp, address token, bytes32 evidenceHash)
        external
        onlyArbiter
        returns (uint256 seized)
    {
        _matureLockups(sp, token, 0);
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 n = q.length;
        for (uint256 i = spLockupCursor[sp][token]; i < n; i++) {
            EarningsLockup storage e = q[i];
            uint256 amt = e.amount;
            // Entries already matured but queued behind a frozen one (possible only
            // after the freeze period was shortened) stay with the SP — skip them.
            if (amt == 0 || e.unlockAt <= block.timestamp) continue;
            seized += amt;
            delete q[i];
        }
        require(seized > 0, "nothing frozen");
        platformEarnings[token] += seized;
        emit EarningsConfiscated(sp, token, seized, evidenceHash);
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

    // Assign/rotate the quality-enforcement role (see arbiter declaration for its
    // strictly bounded powers).
    function setArbiter(address newArbiter) external onlyOwner {
        require(newArbiter != address(0), "invalid arbiter");
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    // Set the freeze window applied to FUTURE settlement credits. Entries already in
    // the queue keep their original unlock time (and strict FIFO order). Bounded by
    // MAX_EARNINGS_FREEZE so a hostile owner cannot lock SP earnings indefinitely.
    function setEarningsFreeze(uint256 newSec) external onlyOwner {
        require(newSec <= MAX_EARNINGS_FREEZE, "freeze too long");
        emit EarningsFreezeUpdated(earningsFreezeSec, newSec);
        earningsFreezeSec = newSec;
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

    // What withdrawEarnings would pay out right now: the matured bucket plus the
    // releasable (matured, uninterrupted) front of the lockup queue.
    function getWithdrawableEarnings(address sp, address token) external view returns (uint256 amount) {
        amount = spEarnings[sp][token];
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 n = q.length;
        for (uint256 i = spLockupCursor[sp][token]; i < n; i++) {
            uint256 amt = q[i].amount;
            if (amt == 0) continue;
            if (q[i].unlockAt > block.timestamp) break; // FIFO: nothing behind this releases yet
            amount += amt;
        }
    }

    // Earnings credited but not withdrawable yet: frozen entries plus any matured
    // entries queued behind a frozen one.
    function getFrozenEarnings(address sp, address token) external view returns (uint256 amount) {
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 n = q.length;
        bool blocked = false;
        for (uint256 i = spLockupCursor[sp][token]; i < n; i++) {
            uint256 amt = q[i].amount;
            if (amt == 0) continue;
            if (!blocked && q[i].unlockAt > block.timestamp) blocked = true;
            if (blocked) amount += amt;
        }
    }

    // Total live earnings: withdrawable + frozen.
    function getTotalEarnings(address sp, address token) external view returns (uint256 amount) {
        amount = spEarnings[sp][token];
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 n = q.length;
        for (uint256 i = spLockupCursor[sp][token]; i < n; i++) {
            amount += q[i].amount;
        }
    }

    // Lockup queue introspection (unlock-schedule display / audits).
    function getLockupCount(address sp, address token) external view returns (uint256 total, uint256 cursor) {
        return (spLockups[sp][token].length, spLockupCursor[sp][token]);
    }

    function getLockup(address sp, address token, uint256 index) external view returns (uint64 unlockAt, uint192 amount) {
        EarningsLockup storage e = spLockups[sp][token][index];
        return (e.unlockAt, e.amount);
    }

    function getSettlement(uint256 batchId) external view returns (SettlementRecord memory) {
        return settlements[batchId];
    }

    function getRefundRequest(uint256 requestId) external view returns (RefundRequest memory) {
        return refundRequests[requestId];
    }

    // ==================== Internal ====================

    // Credit SP earnings from a settled item. With no freeze configured this is the
    // plain immediate credit (pre-v1.1 behavior, zero extra gas); with a freeze it
    // appends to the lockup queue, merging same-unlock credits into one entry.
    //
    // Unlock times are rounded UP to the next multiple of freeze/FREEZE_BUCKETS, so
    // every credit landing inside one such bucket shares an identical unlockAt and
    // merges. Without this, the queue grows by one entry per settlement batch: a
    // 20-minute settlement cadence against a 7-day freeze stacks 504 entries per SP,
    // and the gas to walk them in withdrawEarnings/confiscateFrozenEarnings grows
    // without bound the longer earnings sit unclaimed. With it, the unmatured span is
    // at most FREEZE_BUCKETS+1 entries regardless of cadence, and a year of unclaimed
    // earnings walks ~50 slots instead of ~26k.
    //
    // The freeze is a FLOOR: rounding up can only lengthen the effective window (by
    // less than freeze/FREEZE_BUCKETS, i.e. under 12.5%), never shorten it. For the
    // dispute window that is the safe direction — a fraudulent credit stays seizable
    // slightly longer; nothing ever unlocks early.
    function _creditEarnings(address sp, address token, uint256 amount) internal {
        if (amount == 0) {
            return;
        }
        uint256 freeze = earningsFreezeSec;
        if (freeze == 0) {
            spEarnings[sp][token] += amount;
            return;
        }
        // uint192 downcast is unchecked in Solidity — guard it. Real fund flows are
        // bounded far below 2^192; only an absurd whitelisted token could hit this.
        require(amount <= type(uint192).max, "amount too large");
        uint256 width = freeze / FREEZE_BUCKETS;
        if (width == 0) {
            width = 1; // sub-8s freeze: per-second buckets
        }
        uint256 rawUnlock = block.timestamp + freeze;
        uint64 unlockAt = uint64(((rawUnlock + width - 1) / width) * width);
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 n = q.length;
        if (n > spLockupCursor[sp][token] && q[n - 1].unlockAt == unlockAt) {
            q[n - 1].amount += uint192(amount);
        } else {
            q.push(EarningsLockup({unlockAt: unlockAt, amount: uint192(amount)}));
        }
    }

    // Move matured entries from the front of the lockup queue into the withdrawable
    // spEarnings bucket. maxEntries == 0 means no cap. Stops at the first still-frozen
    // entry: release order is strictly FIFO even when earningsFreezeSec was changed
    // between credits, so a later credit can never overtake an earlier one. Entries
    // zeroed by confiscation are skipped (consumed).
    function _matureLockups(address sp, address token, uint256 maxEntries) internal {
        EarningsLockup[] storage q = spLockups[sp][token];
        uint256 cur = spLockupCursor[sp][token];
        uint256 n = q.length;
        uint256 released;
        uint256 steps;
        while (cur < n) {
            EarningsLockup storage e = q[cur];
            uint256 amt = e.amount;
            if (amt == 0) {
                cur++;
                continue;
            }
            if (e.unlockAt > block.timestamp) {
                break;
            }
            released += amt;
            delete q[cur];
            cur++;
            steps++;
            if (maxEntries != 0 && steps >= maxEntries) {
                break;
            }
        }
        spLockupCursor[sp][token] = cur;
        if (released > 0) {
            spEarnings[sp][token] += released;
        }
    }

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
