# OpenModel Settlement Contract

The on-chain half of OpenModel's billing: a single non-upgradeable Solidity
contract on the **Filecoin FEVM** that holds users' prepaid balances, receives
batched usage settlements from the gateway operator, accrues Storage-Provider
earnings, and enforces a time-locked refund path.

This repository is deliberately small: **the contract, its tests, the deploy
scripts, and the offline billing verifier.** It is the complete trust surface a
user, SP, or auditor needs to read — no gateway internals required.

- Gateway (submits settlements): [openmodel-gateway](https://github.com/6block/openmodel-gateway) v2.x
- SP worker stack (signs receipts): [openmodel](https://github.com/6block/openmodel) v1.2+

## Why you can verify your bill without trusting anyone

Every inference request is attested by the serving worker's **ed25519 signature**
(request hash, response hash, token counts). Every settlement batch commits a
**Merkle root over per-request leaves** into the `detailsHash` stored on-chain.
Chain of custody:

```
worker signature  →  Merkle leaf  →  batch Merkle root  →  sha256(legacyHash ‖ root)
                                                              = detailsHash on-chain
```

Given a `request_id`, [`verify-receipt.py`](verify-receipt.py) checks all five
links offline (only the last step reads the chain):

```bash
python3 verify-receipt.py http://<gateway>:3001 <request_id> \
    https://api.node.glif.io/rpc/v1 0x60D41baEaBe1ABE061AE82c44425debc35bA524A
# 1) worker receipt signature ........ OK (ed25519)
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
| Settlement (operator only) | `submitSettlement(users[], sps[], amounts[], tokens[], requestCounts[], tokenCounts[], detailsHash)` — batch ≤ 100 items, deduplicated by `detailsHash`, per-item skip (not revert) on insufficient balance |
| SP / platform payout | `withdrawEarnings(token)` (SP), `withdrawPlatformEarnings(token, to)` (owner) |
| Governance (owner only) | `setOperator`, `setPlatformFee` (≤ 30%), `setRefundDelay`, `add/removeSupportedToken`, `pause`/`unpause`, two-step `transferOwnership`/`acceptOwnership` |
| Views | `getUserBalance`, `getSPEarnings`, `getSettlement(batchId)`, `getRefundRequest(id)`, `processedBatches(detailsHash)`, `cumulativeRequests()`, `cumulativeTokens()`, `SCHEMA_VERSION()` |

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
- **Inference volume is on-chain.** Every settled batch records how many
  inference requests it covers and how many tokens they consumed
  (`getSettlement(batchId).requestCount` / `.tokenCount`), and two counters
  (`cumulativeRequests`, `cumulativeTokens`) answer "how much inference has this
  network served" in one `eth_call`. The counts are operator-asserted like the
  amounts, but independently checkable: `detailsHash` commits to one Merkle leaf
  per request carrying its token counts, so anyone holding the published leaf set
  can recompute both numbers. Failed items are excluded — their requests are
  carried as debt and counted when they settle, so nothing is counted twice.
- **Non-upgradeable.** The deployed code is the deal. Emergency path: `pause` →
  users reclaim funds → deploy a successor → gateway repoints.

## Deployments

| Network | Address | Params |
|---|---|---|
| Filecoin Calibration (314159) | `0x97a3d202CfF60dD369cdf8F7D514dAe36b469852` | fee 5%, refund delay 3600 s, earnings freeze 604800 s — see [deployments/calibration-v13.json](deployments/calibration-v13.json) |
| Filecoin Mainnet (314) | `0x60D41baEaBe1ABE061AE82c44425debc35bA524A` | trial: fee 0%, refund delay 3600 s, earnings freeze 86400 s — see [deployments/mainnet.json](deployments/mainnet.json) |

`deployments/<network>.json` is the authoritative record binding a chain address
to the source at a given tag (deploy tx, block, constructor params, roles).

## Develop / test / deploy

```bash
npm install
npx hardhat test                          # 84 tests: funds, settlement, refunds,
                                          # roles, pause, reentrancy, edge cases

# deploy (example: Calibration)
export RPC_URL=https://api.calibration.node.glif.io/rpc/v1
export DEPLOYER_PRIVATE_KEY=...           # never commit; see .gitignore
npx hardhat run scripts/calib-deploy-settlement.js --network calibration
# then: record the new address in deployments/, verify source on the explorer,
# and update the gateway's settlement.contract_address.
```

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

## Versioning

`v1.3.0` — the source deployed at both addresses above (Calibration and mainnet).
Because the contract is non-upgradeable, a tag here maps 1:1 to a chain address;
any change ships as a new major tag + new deployment + gateway release.

`SCHEMA_VERSION()` returns the ABI generation a deployment speaks — `3` for this
release. Earlier deployments have no such getter (the call reverts there), which
is how a client checks it is talking to a stats-capable contract before using the
7-argument `submitSettlement` or reading `requestCount`/`tokenCount`. A gateway
must be configured for the generation it targets (`settlement.contract_schema`).

Balances do not carry across deployments: the contract is the ledger, so users of
a retired instance reclaim through its refund path and deposit into the new one.
