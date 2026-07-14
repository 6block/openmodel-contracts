# Verifiable Billing — Byte-Level Specification

This is the normative spec for verifying an OpenModel charge **without trusting
the operator**. `verify-receipt.py` in this repo implements it; this document
lets you re-implement it independently.

## 0. Data you need

For a request you made, you hold its `request_id` (returned in the
`X-Om-Receipt` response header — base64 JSON — or, for streams requested with
`X-OM-Receipt-Req: 1`, in the `om_receipt` SSE event before `[DONE]`).

The gateway serves the proof material on its **public read-only port**
(no authentication):

```
GET http://<gateway>:3001/api/v1/receipt-proof/<request_id>
```

Response fields: `record` (the billing-ledger row incl. the worker `receipt`),
`sp`, `leaf` (hex), `leaf_index`, `proof` (hex sibling path), `merkle_root`,
`legacy_hash`, `details_hash`, `tx_hash`, `block_number`. A proof exists only
**after** the request is inside a confirmed on-chain batch (settlement interval
+ confirmation depth, typically within ~25 min); an unknown or not-yet-settled
`request_id` returns 404 with an explanatory body.

## 1. Worker receipt signature (ed25519)

The serving worker signs a **fixed-template canonical JSON** — field order
hardcoded, string values individually JSON-encoded, no whitespace:

```
{"cached_tokens":<int>,"completion_tokens":<int>,"model":<json-str>,
"prompt_tokens":<int>,"pubkey":<json-str>,"request_id":<json-str>,
"request_sha256":<json-str>,"response_sha256":<json-str>,"ts":<int>,"v":1}
```

(One line; shown wrapped.) `sig` is the ed25519 signature (64-byte hex) over
those exact bytes; `pubkey` is the worker's 32-byte raw public key (hex), also
advertised on the worker's `/health` as `receipt_pubkey`.

- `request_sha256` — sha256 of the exact request body the worker received.
- `response_sha256` — sha256 of the generated text.
- The token counts are the billing quantities.

**Check 1**: rebuild the canonical bytes from the receipt fields and verify the
signature against `pubkey`. A receipt whose `pubkey` differs from the worker's
published key, or whose signature fails, is fabricated.

## 2. Merkle leaf

Each billable request is one leaf. Canonical leaf JSON (again fixed template,
`js()` = JSON string encoding):

```
{"cached_tokens":<int>,"completion_tokens":<int>,"model":js,
"prompt_tokens":<int>,"request_id":js,"sig":js,"sp":js,"wallet":js}
```

`leaf = sha256(canonical bytes)`. `sp` is the SP's payout address (EIP-55),
`wallet` the payer, `sig` the worker signature from step 1 (empty string when
the worker presented none — the leaf then binds only gateway-asserted values).

A request whose original record is no longer on disk settles as an
identity-only **debt leaf**:

```
{"debt":true,"request_id":js,"sp":js,"wallet":js}
```

**Check 2**: recompute the leaf from `record` + `sig` and compare with `leaf`.

## 3. Merkle inclusion

Leaves of a batch are sorted by `request_id` (deduplicated). Tree: binary
sha256 — parent = `sha256(left ‖ right)`; an odd node at any level pairs with
itself. `proof` is the sibling path bottom-up; at each level the current
index's parity picks the side (`even → h = sha256(h ‖ sib)`,
`odd → h = sha256(sib ‖ h)`), index halves each level.

**Check 3**: fold `leaf` up the path; result must equal `merkle_root`.

## 4. Combined details hash

```
details_hash = sha256( legacy_hash ‖ merkle_root )        // 32 + 32 bytes
```

`legacy_hash` is the batch's content-derived dedup identity (items + request
IDs); combining keeps replay-idempotency while binding every request into the
on-chain value.

**Check 4**: recompute and compare with `details_hash`.

## 5. On-chain existence

The contract stores every processed batch permanently:

```
processedBatches(bytes32) → bool     // selector 0x88fcda39
getSettlement(uint256 batchId)       // record incl. detailsHash
```

**Check 5**: `eth_call` `processedBatches(details_hash)` on the settlement
contract (any Filecoin RPC; you choose the endpoint and the contract address —
never let the party you're auditing choose them for you) and require `true`.
`tx_hash` / `block_number` in the proof let you inspect the actual settlement
transaction on an explorer.

## Verifier exit codes

`verify-receipt.py`: `0` VERIFIED · `1` FAILED (a check mismatched — evidence
of misbilling) · `2` usage error · `3` no proof available (not yet settled, or
unknown request_id) · `4` endpoint/RPC unreachable (steps 1–4 may still have
verified offline; result INCONCLUSIVE).

## What this scheme does and doesn't prove

Proves: the charge that settled on-chain for your `request_id` is exactly the
token usage the serving worker attested with its own key, inside a batch whose
content the operator committed irreversibly on-chain.

Doesn't prove: that the *model output quality* matched expectations, or bind
requests the gateway never logged (a gateway that drops a request entirely
simply doesn't charge for it). The receipt's `request_sha256`/`response_sha256`
let you additionally prove *what* was asked/answered if you kept the plaintext.
