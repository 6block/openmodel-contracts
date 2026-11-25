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
   per processed batch,
6. publish inference volume — requests and per-unit quantities (tokens,
   images, audio seconds, characters) — per batch and network-wide.

Everything latency-sensitive (per-request billing, balance gating) happens
off-chain against a cached view; the chain is the settlement and audit layer.

## 2. Roles and trust boundaries

| Role | Key location | Powers |
|---|---|---|
| **user** | user's wallet | deposit, request/claim/cancel refund |
| **SP** | SP's wallet | `withdrawEarnings` of accrued earnings |
| **operator** | HOT key on the gateway server | `submitSettlement` only |
| **arbiter** | separate key, may be cold | `confiscateFrozenEarnings` — may seize an SP's **still-frozen** earnings only, and must commit an `evidenceHash` on-chain with every seizure |
| **owner** | can be COLD storage | fee (≤ 30% cap), refund delay, earnings freeze window, token whitelist, `setOperator`, `setArbiter`, `pause`/`unpause`, platform-earnings withdrawal, two-step ownership transfer |

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
spEarnings[sp][token]          // matured SP payout, pull-withdrawn
spLockups[sp][token][]         // frozen earnings buckets (amount, unlockAt);
spLockupCursor[sp][token]      //   matured lazily past this cursor
platformEarnings[token]        // accrued fee, owner-withdrawn
supportedTokens[token]         // whitelist; NATIVE (0x0) always supported
refundRequests[id]             // (user, token, amount, unlockTime, state)
lockedForRefund[user][token]   // refund-marked slice of the balance
processedBatches[detailsHash]  // replay/dedup guard, permanent
settlements[batchId]           // SettlementRecord: detailsHash, totalAmount,
                               //   settledCount, failedCount, timestamp,
                               //   requestCount, volumeByUnit[4]
settlementNonce                // next batchId
cumulativeRequests             // network-lifetime request counter
cumulativeVolume[4]            // network-lifetime volume, indexed by UNIT_*
cumulativeTokens               // deprecated mirror of cumulativeVolume[UNIT_TOKEN]
platformFeeBps                 // ≤ MAX_FEE_BPS (3000 = 30%)
refundDelaySec                 // refund time-lock (≤ MAX_REFUND_DELAY, 30d)
earningsFreezeSec              // SP earnings freeze window (≤ 90d)
arbiter                        // seizure role; address(0) = disabled
SCHEMA_VERSION = 4             // constant; gateways pin their ABI against it
UNIT_TOKEN = 0, UNIT_IMAGE = 1, UNIT_AUDIO_SECOND = 2,
UNIT_CHARACTER = 3, UNIT_COUNT = 4  // volume unit indices (part of the ABI)
paused                         // emergency switch (owner)
```

`SettlementRecord` contains a fixed-size array, which the compiler-generated
`settlements(batchId)` getter leaves out; read full records with
`getSettlement(batchId)`. `cumulativeVolume(unit)` is the generated getter of
the public array and takes the unit index.

### Units

| Constant | Index | Unit | One unit is |
|---|---|---|---|
| `UNIT_TOKEN` | 0 | `token` | one prompt or completion token of text or image-understanding chat (images count as visual prompt tokens) |
| `UNIT_IMAGE` | 1 | `image` | one delivered generated image |
| `UNIT_AUDIO_SECOND` | 2 | `audio_second` | one second of transcribed input audio; each request's duration is rounded up to whole seconds |
| `UNIT_CHARACTER` | 3 | `character` | one Unicode code point of speech-synthesis input text |

The set is fixed in the contract rather than passed as operator-chosen labels:
the public counters stay one `eth_call` away and bounded in storage, and every
unit the gateway can bill already has its slot. The contract knows nothing about
models or prices — the gateway's catalog maps each model to its unit and price —
so the unit is carried explicitly in the volume vector instead of being inferred
from a model name.

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
`submitSettlement(users[], sps[], amounts[], tokens[], requestCounts[],
itemVolume[], detailsHash)` — `onlyOperator whenNotPaused nonReentrant`,
arrays ≤ `MAX_BATCH_SIZE` (100), all six arrays the same length.
`requestCounts[i]` is the number of requests aggregated into item `i`;
`itemVolume[i]` is a `uint256[4]` with how much of each unit those requests
produced, indexed by the `UNIT_*` constants (a text-only item is
`[tokens, 0, 0, 0]`; an item mixing chat and image generation for the same
user and SP carries both columns). For settled items only, the sums go into the
batch record (`requestCount`, `volumeByUnit`) and advance `cumulativeRequests`
and `cumulativeVolume[u]` (plus the deprecated `cumulativeTokens` mirror); they
power the network-stats endpoint.

Per item: debit `balances[user][token]`; split `amount` into
`fee = amount × platformFeeBps / 10000` → `platformEarnings`, remainder →
the SP's earnings. With `earningsFreezeSec > 0` the SP share lands in a
**frozen lockup bucket** first (`spLockups`), maturing into withdrawable
`spEarnings` after the freeze window — `withdrawEarnings` matures lazily, and
`matureEarnings(sp, token, maxEntries)` lets anyone advance the cursor in
bounded steps. The freeze doubles as the dispute window: the arbiter can seize
**only still-frozen** amounts (`confiscateFrozenEarnings`, evidenceHash
committed on-chain); matured earnings can never be taken.

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

#### Why volume is attributed per item, with explicit units

- **Per item, not one batch total.** Items are grouped by (user, SP), and one
  user can send text, vision, image and speech requests to the same SP within
  one settlement window. When an item is skipped, its requests are carried as
  debt and re-submitted in a later batch. Only volume attached to each item can
  be excluded exactly for the skipped item; a single batch total could not be
  trimmed, and the re-submitted debt would be counted twice.
- **Explicit per-unit columns, not inferred from the model.** The contract has
  no catalog, and units are not additive — four images and four tokens are
  different things, and summing them into one number would describe nothing. A
  per-unit column keeps each batch self-describing: an auditor reading only the
  chain can tell what was served.
- **Outside `detailsHash`, never touching funds.** `detailsHash` must stay a pure
  content hash of the economic batch, because it is the dedup and crash-replay
  key, so the stats arrays are deliberately not covered by it. The volume
  figures are operator-asserted, exactly like the amounts; they are checked
  off-chain against the Merkle leaves (each leaf carries a request's token
  counts, or its `price_unit` and `quantity` — see verification.md), and no
  balance, fee or earnings computation reads them. The funds logic of this
  generation is the same as in v1.3; only the shape of the statistics changed,
  which is why `SCHEMA_VERSION` is `4`.

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

`pause()` freezes deposits (incl. `receive()`) and settlements — an emergency
brake for a compromised operator key or a discovered defect. The **entire
refund path stays open** (request, claim, cancel carry no `whenNotPaused`), as
do SP withdrawals: a pause blocks new money coming in and new charges landing,
never a user's or SP's exit.

## 6. Events

`Deposited(user, token, amount)`, `SettlementExecuted(batchId, totalAmount,
platformFee, settledCount, failedCount, detailsHash, requestCount,
uint256[4] volumeByUnit)`, `SettlementItemFailed(batchId, index, user, reason)`,
`RefundRequested/RefundClaimed/RefundCancelled`, `SPWithdrawn(sp, token,
amount)`, `PlatformWithdrawn`, `PlatformFeeUpdated`, `RefundDelayUpdated`,
`TokenAdded/TokenRemoved`, `OperatorUpdated`, `ArbiterUpdated`,
`EarningsFreezeUpdated`, `EarningsConfiscated(sp, token, amount,
evidenceHash)`, `OwnerTransferProposed/OwnerTransferred`, `Paused/Unpaused`. Settlement events are load-bearing:
the gateway's per-item failure handling and its local audit log are built on
them, and `getSettlement(batchId)` + `processedBatches` are what third-party
verification checks against. Indexers must decode `SettlementExecuted` with the
schema-4 ABI: its last argument is the `uint256[4]` volume vector, not a scalar.

## 7. Known limits & audit notes

- **Fee-on-transfer / rebasing ERC-20s are not supported**; the whitelist must
  only ever admit standard tokens (mainnet checklist item).
- The contract trusts the operator's *accounting* (amounts per user/SP); what
  bounds that trust is off-chain verifiability (worker-signed receipts +
  Merkle commitment, see verification.md) plus the balance cap — it cannot
  invent money, only misattribute up to a user's deposit, detectably.
- Request counts and per-unit volume are operator-asserted statistics with no
  on-chain cross-check against the amounts; they are verifiable off-chain only
  and cannot move funds. A misreported figure distorts the public stats, never
  a balance.
- FEVM specifics: gas units are ~2 orders of magnitude larger than Ethereum
  mainnet for comparable work (deploy ≈ 1.1e8 gas, batch ≈ 5.5e7+); base fee
  spikes with network sealing activity — operator gas budgeting should assume
  spikes, not averages.
