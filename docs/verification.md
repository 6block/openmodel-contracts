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

Response fields: `record` (the billing-ledger row incl. the worker `receipt`;
for a request billed in a non-token unit it also carries `quantity` and
`asset_hash`), `sp`, `leaf` (hex), `price_unit` (present only for non-token
units), `leaf_index`, `proof` (hex sibling path), `merkle_root`,
`legacy_hash`, `details_hash`, `tx_hash`, `block_number`. A proof exists only
**after** the request is inside a confirmed on-chain batch (settlement interval
+ confirmation depth, typically within ~25 min). A request that is billed but
not yet settled returns **202** with `"status":"pending_settlement"`,
`next_settlement_eta_sec` and the `worker_receipt` (whose signature can be
checked at once); an unknown `request_id` returns 404 with an explanatory body.

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

**A request billed in a non-token unit signs a different, equally fixed
template.** A model priced per image, per audio second or per character has no
token counts to attest, so its payload carries the measured quantity and the
digest of the asset instead. This template has eight fields and **no
`pubkey`** (the receipt JSON still contains `pubkey`, the zero token counts and
`sig`, but they are not part of the signed bytes):

```
{"asset_hash":<json-str>,"model":<json-str>,"quantity":<int>,
"request_id":<json-str>,"request_sha256":<json-str>,
"response_sha256":<json-str>,"ts":<int>,"v":1}
```

(One line; shown wrapped.) Which template applies is self-evident from the
receipt: a non-zero `quantity` means the asset form; its absence (or zero) means
the token form above. What `quantity` and `asset_hash` mean depends on the
model's billing unit:

| Unit | `quantity` | `asset_hash` (sha256, hex) |
|---|---|---|
| `image` | images delivered | the decoded image bytes, concatenated in order |
| `audio_second` (transcription) | input audio duration, rounded **up** to whole seconds, minimum 1 | the uploaded audio file, byte for byte |
| `character` (speech synthesis) | Unicode code points of the `input` text, no trimming or normalization | the returned audio bytes |

In the asset form `response_sha256` equals `asset_hash`, so the receipt
identifies the exact bytes that were billed (for transcription that is the
uploaded audio, not the returned text). `request_sha256` is still the sha256 of
the exact request body the worker received — for transcription, the whole
multipart body. Images are delivered as PNG and synthesized speech as WAV; the
digest is over those bytes as delivered (for `b64_json` images, after base64
decoding).

In every case the gateway computes both values itself from bytes it handled —
the delivered images, the uploaded audio, the request text, the returned audio —
and refuses a receipt whose attested values disagree.

Encoding rules, shared by both receipt templates and all leaf shapes below:

- Field order is exactly as shown (ASCII key order); no whitespace anywhere.
- `<int>` is a plain base-10 integer: no sign, no leading zeros, no exponent.
- `json-str` (`js` below) means the value is JSON-encoded as a string, with raw
  UTF-8 for non-ASCII characters (Go's `encoding/json`; Python's
  `json.dumps(s, ensure_ascii=False)`), so a non-ASCII model name appears as its
  UTF-8 bytes, never as `\uXXXX`. `"` and `\` are backslash-escaped. The
  whole string is then encoded to bytes as UTF-8 before hashing or signing.
- Go's encoder additionally escapes `<`, `>`, `&`, U+2028 and U+2029 (as
  `\u003c` …); Python's does not. The values that appear in these fields —
  hex digests, `req-` + hex request ids, EVM addresses, unit names and catalog
  model ids — do not contain those characters, so the two produce identical
  bytes; a re-implementation should reject rather than guess if it meets one.

**Check 1**: rebuild the canonical bytes from the receipt fields and verify the
signature against `pubkey`. A receipt whose `pubkey` differs from the worker's
published key, or whose signature fails, is fabricated.

## 2. Merkle leaf

Each billable request is one leaf. The leaf shape follows the request's billing
unit. Canonical token leaf JSON (fixed template, `js()` = JSON string encoding):

```
{"cached_tokens":<int>,"completion_tokens":<int>,"model":js,
"prompt_tokens":<int>,"request_id":js,"sig":js,"sp":js,"wallet":js}
```

A request billed in a non-token unit commits a leaf carrying its asset digest and
quantity in place of token counts:

```
{"asset_hash":js,"model":js,"price_unit":js,"quantity":<int>,
"request_id":js,"sig":js,"sp":js,"wallet":js}
```

`price_unit` is the unit the model is priced in (`"image"`, `"audio_second"` or
`"character"`), served as the top-level `price_unit` of the proof payload.
`quantity` and `asset_hash` come from the signed receipt when it attests a
quantity; for a record whose worker presented no receipt they are the gateway's
own count and digest of the delivered asset (`record.quantity`,
`record.asset_hash`), and `sig` is `""`. A token leaf does **not** carry
`price_unit`: its shape already implies the unit, and keeping it out keeps
token leaves byte-identical across releases, so token proofs from any release
verify with the same code.

`leaf = sha256(canonical bytes)`. `sp` is the SP's payout address (EIP-55),
`wallet` the payer, `sig` the worker signature from step 1 (empty string when
the worker presented none — the leaf then binds only gateway-asserted values).

A request whose original record is no longer on disk settles as an
identity-only **debt leaf**:

```
{"debt":true,"request_id":js,"sp":js,"wallet":js}
```

**Check 2**: recompute the leaf from `record` + `sig` (+ `price_unit` for an
asset leaf) and compare with `leaf`. Use the asset shape when the receipt's or
the record's `quantity` is greater than zero, the token shape otherwise; if
neither matches, also try the debt shape.

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

## 6. Worked example: an image-generation receipt

A `POST /v1/images/generations` response carried this `X-Om-Receipt` header
(base64-decoded; `ts` and the hashes are real values from a running deployment):

```json
{"v": 1, "request_id": "req-da6b9de8637f0270",
 "model": "stabilityai/stable-diffusion-xl-base-1.0",
 "request_sha256": "5407c7464863d2534086c70d8f4406ecfa3416d60caf4ef5c66e030d5c2c4683",
 "response_sha256": "7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042",
 "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0, "ts": 1794887025,
 "pubkey": "ce436c909d258835376f6a51c67e365918659e23668ad4df81cb4819284b0a89",
 "sig": "d5fe39980b79a1a54b96d7f80d3d16f24b46889ec9c247fadf5518a87b83d6bf24bf1d82104f4600ff54a532be6afa2be4a9d969039ba6cc0ceed8b2cfbe680c",
 "quantity": 1,
 "asset_hash": "7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042"}
```

`quantity` is 1, so the asset template applies. The signed bytes (372 bytes,
one line) are:

```
{"asset_hash":"7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042","model":"stabilityai/stable-diffusion-xl-base-1.0","quantity":1,"request_id":"req-da6b9de8637f0270","request_sha256":"5407c7464863d2534086c70d8f4406ecfa3416d60caf4ef5c66e030d5c2c4683","response_sha256":"7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042","ts":1794887025,"v":1}
```

Check 1 offline (`pip install cryptography`):

```bash
python3 - <<'PY'
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
payload = b'{"asset_hash":"7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042","model":"stabilityai/stable-diffusion-xl-base-1.0","quantity":1,"request_id":"req-da6b9de8637f0270","request_sha256":"5407c7464863d2534086c70d8f4406ecfa3416d60caf4ef5c66e030d5c2c4683","response_sha256":"7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042","ts":1794887025,"v":1}'
pub = bytes.fromhex("ce436c909d258835376f6a51c67e365918659e23668ad4df81cb4819284b0a89")
sig = bytes.fromhex("d5fe39980b79a1a54b96d7f80d3d16f24b46889ec9c247fadf5518a87b83d6bf24bf1d82104f4600ff54a532be6afa2be4a9d969039ba6cc0ceed8b2cfbe680c")
Ed25519PublicKey.from_public_bytes(pub).verify(sig, payload)  # raises InvalidSignature on mismatch
print("signature OK")
PY
```

To tie the receipt to the picture you received, decode `data[0].b64_json` from
the response body and check `sha256(png bytes) == asset_hash` (for `n` images,
the sha256 of all decoded images concatenated in order).

The leaf this request commits, with the proof payload's `price_unit` =
`"image"` and — for illustration — payer `0x1111…1111` and SP
`0x2222…2222` (a real proof serves the actual `wallet` in `record` and the SP
payout address in `sp`):

```
{"asset_hash":"7b74b7a72695c705328184803384091a4a49162bf32333ee565f7bd9a19b1042","model":"stabilityai/stable-diffusion-xl-base-1.0","price_unit":"image","quantity":1,"request_id":"req-da6b9de8637f0270","sig":"d5fe39980b79a1a54b96d7f80d3d16f24b46889ec9c247fadf5518a87b83d6bf24bf1d82104f4600ff54a532be6afa2be4a9d969039ba6cc0ceed8b2cfbe680c","sp":"0x2222222222222222222222222222222222222222","wallet":"0x1111111111111111111111111111111111111111"}
```

`leaf = sha256(those bytes) =
0cfb8720f7d2612076ba9a34b731fdcf5459a0a4a7682a624ca178ae730945e4`. Checks 3–5
then proceed exactly as for a token leaf.

Speech receipts follow the same pattern: for `POST /v1/audio/speech`,
`quantity` is the number of code points in `input` and `asset_hash` is the
sha256 of the returned WAV body; for `POST /v1/audio/transcriptions`,
`quantity` is the billed seconds and `asset_hash` is the sha256 of the uploaded
file. The leaf's `price_unit` is `"character"` or `"audio_second"`
respectively.

## Verifier exit codes

`verify-receipt.py`: `0` VERIFIED · `1` FAILED (a check mismatched — evidence
of misbilling) · `2` usage error · `3` no proof available (billed but not yet
settled — the verifier prints `PENDING` and the next-settlement ETA — or unknown
request_id) · `4` endpoint/RPC unreachable (steps 1–4 may still have verified
offline; result INCONCLUSIVE).

## What this scheme does and doesn't prove

Proves: the charge that settled on-chain for your `request_id` is exactly the
usage the serving worker attested with its own key — token counts, or the
quantity and asset digest for image and speech requests — inside a batch whose
content the operator committed irreversibly on-chain.

Doesn't prove: that the *model output quality* matched expectations, or bind
requests the gateway never logged (a gateway that drops a request entirely
simply doesn't charge for it). The receipt's `request_sha256`/`response_sha256`
let you additionally prove *what* was asked/answered if you kept the plaintext
(for an asset request, keeping the image, the audio you uploaded or the audio
you received is enough to recompute `asset_hash`).

Also not proved by this check: the per-batch volume figures stored on-chain
(`requestCount`, `volumeByUnit`). They are operator-asserted statistics; to
check them, recompute the counts and per-unit quantities from the batch's
leaves. They never affect balances.
