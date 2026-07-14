# OpenModelSettlement — Design Notes

Audience: auditors, integrators, and operators. This documents the state model,
roles and trust boundaries, money flows, invariants, and the deliberate design
trade-offs of the settlement contract. Byte-level verification formats live in
[verification.md](verification.md).

## 1. Purpose and position in the system

OpenModel meters AI inference off-chain (the gateway logs and prices every
request) and settles **in batches** on-chain. The contract's job is narrow:

1. hold users' **prepaid** balances (FIL native + whitelisted ERC-20 stablecoins),
2. execute operator-submitted settlement batches that move value
   user → SP earnings (minus a platform fee),
3. let SPs and the platform withdraw accrued earnings,
4. give users a **time-locked** exit (refunds),
5. anchor billing verifiability by storing a content-derived `detailsHash`
   per processed batch.

Everything latency-sensitive (per-request billing, balance gating) happens
off-chain against a cached view; the chain is the settlement and audit layer.

## 2. Roles and trust boundaries

| Role | Key location | Powers |
|---|---|---|
| **user** | user's wallet | deposit, request/claim/cancel refund |
| **SP** | SP's wallet | `withdrawEarnings` of accrued earnings |
| **operator** | HOT key on the gateway server | `submitSettlement` only |
| **owner** | can be COLD storage | fee (≤ 30% cap), refund delay, token whitelist, `setOperator`, `pause`/`unpause`, platform-earnings withdrawal, two-step ownership transfer |

Mitigations for the operator-accounting trust were considered and deliberately
deferred: (a) signing every inference request to authorize settling exactly that
usage — rejected for breaking OpenAI-SDK/LangChain compatibility on the request
path; (b) periodically signing a time-boxed spending allowance — rejected
because, compared with simply depositing the same amount before use, it does
not fundamentally widen the security gap, while both options add client
friction and system complexity. The current design stands; a more
decentralized scheme remains under consideration for future versions.

The deployer starts as **both** owner and operator (constructor sets
`owner = operator = msg.sender`) so small/trial deployments work with one key;
`setOperator` separates duties without redeployment.

Ownership transfer is **two-step** (`transferOwnership` proposes,
`acceptOwnership` claims) so a typo'd address cannot brick governance.

## 3. State model

```solidity
balances[user][token]          // prepaid deposits, debited by settlement
spEarnings[sp][token]          // accrued SP payout, pull-withdrawn
platformEarnings[token]        // accrued fee, owner-withdrawn
supportedTokens[token]         // whitelist; NATIVE (0x0) always supported
refundRequests[id]             // (user, token, amount, unlockTime, state)
processedBatches[detailsHash]  // replay/dedup guard, permanent
settlements[batchId]           // SettlementRecord: detailsHash, totalAmount,
                               //   settledCount, failedCount, timestamp
settlementNonce                // next batchId
platformFeeBps                 // ≤ MAX_FEE_BPS (3000 = 30%)
refundDelaySec                 // refund time-lock
paused                         // emergency switch (owner)
```

## 4. Money flows

### Deposit
`depositFIL()` (payable) or `depositToken(token, amount)` (whitelisted ERC-20,
`transferFrom`). A **bare FIL transfer** hits `receive()` and is also credited
as a deposit — guarded by `whenNotPaused` so the pause actually closes the
deposit door. ⚠️ Filecoin-native "method 0" sends to the contract's f4 address
do **not** execute EVM code; only EVM-level transfers (eth_sendTransaction /
`CALL`) are credited. Exchanges withdrawing natively can lose funds — deposit
from an EVM wallet.

### Settlement (the core flow)
`submitSettlement(users[], sps[], amounts[], tokens[], detailsHash)` —
`onlyOperator whenNotPaused nonReentrant`, arrays ≤ `MAX_BATCH_SIZE` (100).

Per item: debit `balances[user][token]`; split `amount` into
`fee = amount × platformFeeBps / 10000` → `platformEarnings`, remainder →
`spEarnings[sp][token]`.

Two properties matter for correctness under real-world failure:

- **Idempotency**: if `processedBatches[detailsHash]` is already true the call
  is a no-op success. `detailsHash` is derived off-chain purely from batch
  content, so the gateway's crash-recovery replays and reorg re-submissions
  cannot double-charge. This invariant carried three soak campaigns (2.6 M+
  requests) with zero reconciliation drift.
- **Per-item skip, not revert**: an item whose user balance has meanwhile
  dropped (e.g. a refund claimed between planning and mining) is **skipped**
  with a `SettlementItemFailed` event; the rest of the batch lands. The gateway
  parses the receipt events, reverses the skipped amount from its settled
  totals, and carries it as debt. A whole-batch revert would let one drained
  wallet block everyone else's settlement.

### Refunds (time-locked exit)
`requestRefund` locks the amount out of the spendable balance and starts the
clock; `claimRefund` pays out after `refundDelaySec`; `cancelRefund` restores
the balance. The delay must be configured **much larger than the settlement
interval** — that ordering guarantees usage already consumed is debited before
the user can exit, closing the "spend then run" window. (Trial deployment:
delay 3600 s vs settlement every ~20 min.)

### Withdrawals
Pull-based: `withdrawEarnings` (SP), `withdrawPlatformEarnings` (owner).
`nonReentrant`; native transfers use low-level call with success check.

## 5. Pause semantics

`pause()` freezes deposits (incl. `receive()`), settlements, and refund
*requests* — an emergency brake for a compromised operator key or a discovered
defect. Already-earned SP withdrawals and already-unlocked refund claims are
the escape hatches that keep user/SP funds reachable during an incident.

## 6. Events

`Deposited`, `SettlementExecuted(batchId, detailsHash, totalAmount,
settledCount, failedCount)`, `SettlementItemFailed(batchId, index, user, sp,
amount, token)`, `RefundRequested/RefundClaimed/RefundCancelled`,
`EarningsWithdrawn`, `PlatformFeeChanged`, `RefundDelayChanged`,
`TokenAdded/TokenRemoved`, `OperatorChanged`, `OwnerTransferProposed/
OwnershipTransferred`, `Paused/Unpaused`. Settlement events are load-bearing:
the gateway's per-item failure handling and its local audit log are built on
them, and `getSettlement(batchId)` + `processedBatches` are what third-party
verification checks against.

## 7. Known limits & audit notes

- **Fee-on-transfer / rebasing ERC-20s are not supported**; the whitelist must
  only ever admit standard tokens (mainnet checklist item).
- The contract trusts the operator's *accounting* (amounts per user/SP); what
  bounds that trust is off-chain verifiability (worker-signed receipts +
  Merkle commitment, see verification.md) plus the balance cap — it cannot
  invent money, only misattribute up to a user's deposit, detectably.
- FEVM specifics: gas units are ~2 orders of magnitude larger than Ethereum
  mainnet for comparable work (deploy ≈ 1.1e8 gas, batch ≈ 5.5e7+); base fee
  spikes with network sealing activity — operator gas budgeting should assume
  spikes, not averages.
