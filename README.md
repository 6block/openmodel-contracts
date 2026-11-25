# OpenModel Settlement Contract

The on-chain half of OpenModel's billing: a single non-upgradeable Solidity
contract on the **Filecoin FEVM** that holds users' prepaid balances, receives
batched usage settlements from the gateway operator, accrues Storage-Provider
earnings, and enforces a time-locked refund path.

This repository is deliberately small: **the contract, its tests, the deploy
scripts, and the offline billing verifier.** It is the complete trust surface a
user, SP, or auditor needs to read — no gateway internals required.

- Gateway (submits settlements): [openmodel-gateway](https://github.com/6block/openmodel-gateway) v2.2+ for this contract generation (`settlement.contract_schema: 4`)
- SP worker stack (signs receipts): [openmodel](https://github.com/6block/openmodel) v1.5+ (token receipts since v1.2; image and speech receipts since v1.5)

## Why you can verify your bill without trusting anyone

Every inference request is attested by the serving worker's **ed25519 signature**
over the request hash, the response hash and the billed quantity: token counts
for text and vision chat, or — for image generation, speech recognition and
speech synthesis — the delivered quantity plus the sha256 of the delivered (or
uploaded) asset. Every settlement batch commits a **Merkle root over
per-request leaves** into the `detailsHash` stored on-chain.
Chain of custody:

```
worker signature  →  Merkle leaf  →  batch Merkle root  →  sha256(legacyHash ‖ root)
                                                              = detailsHash on-chain
```

Given a `request_id`, [`verify-receipt.py`](verify-receipt.py) checks all five
links offline (only the last step reads the chain):

```bash
# RPC note: prefer ankr for reads — glif intermittently returns empty
# eth_call bodies that parse as zeros. Requires: pip install cryptography
# hosted alpha base: https://openmodel.filfox.info
python3 verify-receipt.py http://<gateway>:3001 <request_id> \
    https://rpc.ankr.com/filecoin 0x29b994f63D91e447945a1cDeA2776167B7415c26
# 1) worker receipt signature ........ OK (ed25519, token payload)
# 2) leaf == sha256(record) .......... OK
# 3) merkle inclusion proof .......... OK
# 4) sha256(legacy‖root)==details .... OK
# 5) on-chain processedBatches ....... OK (tx 0x… block …)
# RESULT: VERIFIED ✔
```

Exact byte-level formats: [docs/verification.md](docs/verification.md).

> Scope: this verifies charges for requests **you actually made**. For what the
> scheme does *not* prevent (a malicious operator fabricating usage outright),
> read **Trust model & limitations** below before depositing.

## Contract at a glance

| Area | Functions |
|---|---|
| User funds | `depositFIL()` payable, `depositToken(token, amount)`, `receive()` (bare FIL transfer = deposit) |
| Refunds (time-locked) | `requestRefund(token, amount)` → wait `refundDelaySec` → `claimRefund(id)`; `cancelRefund(id)` anytime |
| Settlement (operator only) | `submitSettlement(users[], sps[], amounts[], tokens[], requestCounts[], itemVolume[], detailsHash)` — `itemVolume[i]` is a `uint256[4]` per-unit volume vector; batch ≤ 100 items, deduplicated by `detailsHash`, per-item skip (not revert) on insufficient balance |
| SP / platform payout | `withdrawEarnings(token)` (SP; matures due lockups first), `withdrawPlatformEarnings(token, to)` (owner), `matureEarnings(sp, token, maxEntries)` (anyone) |
| Earnings freeze & disputes | settled SP earnings sit frozen for `earningsFreezeSec` (dispute window); `confiscateFrozenEarnings(sp, token, evidenceHash)` — **arbiter only, still-frozen amounts only**, every seizure commits an evidence hash on-chain |
| Governance (owner only) | `setOperator`, `setArbiter`, `setPlatformFee` (≤ 30%), `setRefundDelay`, `setEarningsFreeze` (≤ 90 d), `add/removeSupportedToken`, `pause`/`unpause`, two-step `transferOwnership`/`acceptOwnership` |
| Views | `getUserBalance`, `getSPEarnings`, `getWithdrawableEarnings(sp, token)`, `getFrozenEarnings(sp, token)`, `getTotalEarnings(sp, token)`, `getLockupCount`/`getLockup`, `getSettlement(batchId)`, `getRefundRequest(id)`, `processedBatches(detailsHash)`, `cumulativeRequests()`, `cumulativeVolume(unit)`, `cumulativeTokens()` (deprecated mirror of `cumulativeVolume(UNIT_TOKEN)`), `SCHEMA_VERSION()`, `UNIT_TOKEN` / `UNIT_IMAGE` / `UNIT_AUDIO_SECOND` / `UNIT_CHARACTER` / `UNIT_COUNT` |

### Billing units

Inference volume is tallied per unit. The unit indices are fixed constants and
are part of the ABI: they index `itemVolume[i]`, `volumeByUnit` and
`cumulativeVolume`.

| Constant | Index | Unit | Counts |
|---|---|---|---|
| `UNIT_TOKEN` | 0 | `token` | prompt + completion tokens of text and image-understanding (vision) chat |
| `UNIT_IMAGE` | 1 | `image` | generated images delivered |
| `UNIT_AUDIO_SECOND` | 2 | `audio_second` | seconds of transcribed input audio, rounded up per request |
| `UNIT_CHARACTER` | 3 | `character` | characters (Unicode code points) of speech-synthesis input |

`UNIT_COUNT` is `4`. Prices per unit live in the gateway's catalog, not in the
contract: the contract moves the per-item `amounts` the operator submits and
records volume next to them. Live models and prices: `GET /v1/catalog` on the
gateway.

Key properties (full rationale in [docs/contract-design.md](docs/contract-design.md)):

- **Owner ≠ operator.** The operator (a hot key on the gateway server) can *only*
  submit settlements; it cannot withdraw user funds, change fees, or pause. The
  owner key can stay cold. The deployer starts as both — assign a dedicated
  operator with `setOperator` when separating duties.
- **Idempotent settlement.** `detailsHash` is derived from batch content; replays
  (crash recovery, reorg re-submits) are no-ops. Partial failures skip the item
  and emit `SettlementItemFailed` instead of reverting the batch.
- **Refund delay >> settlement interval** — a user cannot front-run the debit of
  usage they already consumed.
- **Inference volume is on-chain, per unit.** Every settled batch records how
  many inference requests it covers and how much of each unit they produced
  (`getSettlement(batchId).requestCount` / `.volumeByUnit[unit]`), the
  `SettlementExecuted` event carries the same `requestCount` and
  `uint256[4] volumeByUnit`, and the counters `cumulativeRequests()` and
  `cumulativeVolume(unit)` answer "how much inference has this network served"
  in one `eth_call` each. Read batch records through `getSettlement`: the
  auto-generated `settlements(batchId)` getter omits the array member. Failed
  items are excluded — their requests are carried as debt and counted when they
  settle, so nothing is counted twice.
- **Volume figures cannot move funds.** Request counts and per-unit volume are
  operator-asserted, like the amounts. They are verified off-chain: `detailsHash`
  commits to one Merkle leaf per request carrying its token counts or its unit
  and quantity, so anyone holding the leaf set (each request's proof is public)
  can recompute them. They are not covered by `detailsHash` and play no part in
  any balance or earnings computation; the funds logic — debit, fee split,
  earnings freeze, refunds, withdrawals — is identical to the previous
  generation.
- **Non-upgradeable.** The deployed code is the deal. Emergency path: `pause` →
  users reclaim funds → deploy a successor → gateway repoints.

## Deployments

| Network | Address | Params |
|---|---|---|
| Filecoin Calibration (314159) | `0x8Fd8478dfdb3B86F8536AAEd2448A94cb04fC992` | v1.4, fee 5%, refund delay 3600 s, earnings freeze 604800 s — see [deployments/calibration-v14.json](deployments/calibration-v14.json) |
| Filecoin Mainnet (314) | `0x29b994f63D91e447945a1cDeA2776167B7415c26` | v1.4 — see [deployments/mainnet.json](deployments/mainnet.json) |

Superseded instances (v1.3: Calibration `0x97a3d202CfF60dD369cdf8F7D514dAe36b469852`,
mainnet `0x60D41baEaBe1ABE061AE82c44425debc35bA524A`; earlier ones in
`deployments/*-retired.json`) keep their balances and their refund path; they no
longer receive settlements.

`deployments/<network>.json` is the authoritative record binding a chain address
to the source at a given tag (deploy tx, block, constructor params, roles).

## Develop / test / deploy

```bash
npm install
npx hardhat test                          # 120 tests: funds, settlement, refunds, roles,
                                          # pause, reentrancy, per-unit batch stats, earnings freeze

# deploy (example: Calibration)
export FEVM_RPC_URL=https://api.calibration.node.glif.io/rpc/v1   # hardhat.config.js reads FEVM_RPC_URL (calibration) / MAINNET_RPC_URL (mainnet)
export DEPLOYER_PRIVATE_KEY=...           # never commit; see .gitignore
npx hardhat run scripts/calib-deploy-settlement.js --network calibration
# then: record the new address in deployments/, verify source on the explorer,
# and update the gateway's settlement.contract_address.
```

Mainnet deployment is one command; it asks only for the owner's private key
(hidden input, never written to disk), runs the test suite, deploys, sets the
earnings freeze, whitelists USDFC, hands settlement to the operator key, checks
the on-chain state, writes `deployments/mainnet-v14.json` and verifies the
source on Blockscout:

```bash
./scripts/deploy-mainnet.sh
```

If a step after the deploy fails, the script prints the contract address and
the command that resumes on that same contract.

Gas expectations (measured on Calibration; FEVM gas units): deploy ≈ 1.1e8,
one settlement batch ≈ 5.5e7 + per-item cost. At typical base fees this is
fractions of a cent; budget for base-fee spikes, not the average.

## Trust model & limitations — read before depositing

This contract does **not** make the operator trustless.

The contract has no way to verify that billed usage actually happened — the
operator is trusted for accounting. **A malicious operator can submit
fabricated settlements that drain a user's deposited balance to an SP address
the operator itself controls**, up to that user's balance.

We have considered mitigations for this. One option is signing every inference
request, authorizing settlement of exactly that usage — but this breaks
compatibility with existing tooling such as the OpenAI SDK and LangChain.
Another is periodically signing an allowance that caps spending within a time
window — but compared with simply depositing that same amount before use, it
does not fundamentally widen the security gap. Both approaches add usage
friction and system complexity, so the current version keeps the present
design; we may continue to weigh a more decentralized scheme in future
versions.

What bounds the trust today: (a) worker-signed receipts + the on-chain Merkle
commitment make fabricated usage detectable (see verification.md); the per-unit volume
figures recorded on-chain are operator-asserted in the same way and are checked
the same way, and they never move funds; (b) SP
earnings stay **frozen for `earningsFreezeSec`** after settlement, and within
that window an **arbiter** role can seize provably-fraudulent earnings —
each seizure must commit an `evidenceHash` on-chain, so it is publicly
attributable. Matured earnings can never be seized.

## Versioning

`v1.4.0` — the source deployed at both addresses above (Calibration and mainnet).
Because the contract is non-upgradeable, a tag here maps 1:1 to a chain address;
any change ships as a new major tag + new deployment + gateway release.

`SCHEMA_VERSION()` returns the ABI generation a deployment speaks — `4` for this
release (`3` = v1.3: 7-argument `submitSettlement`, one token column; v1.2 and
earlier have no such getter and the call reverts there). A client checks it
before using the per-unit `submitSettlement` or decoding a `SettlementRecord` /
`SettlementExecuted`: the v1.4 record and event end in a `uint256[4]
volumeByUnit` where v1.3 had a scalar `tokenCount`, so decoding one with the
other's layout yields wrong values. `cumulativeTokens()` is kept as a deprecated
mirror of `cumulativeVolume(UNIT_TOKEN)` so existing readers keep working. A
gateway must be configured for the generation it targets
(`settlement.contract_schema: 4` for this release); it checks `SCHEMA_VERSION()`
at startup.

Balances do not carry across deployments: the contract is the ledger, so users of
a retired instance reclaim through its refund path and deposit into the new one.

## License

Copyright 2026 6block. Licensed under the [Apache License, Version 2.0](LICENSE),
except the Solidity sources under `contracts/`, which are MIT-licensed as declared
in their `SPDX-License-Identifier` headers (the deployed, source-verified contract
is compiled from these files exactly as published).
