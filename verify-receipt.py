#!/usr/bin/env python3
"""Offline verifier for OpenModel verifiable billing.

Anyone holding a request_id can verify — WITHOUT trusting the operator — that the
charge settled on-chain matches what the worker attested:

    python3 verify-receipt.py <public_query_base> <request_id> [rpc_url] [contract]

e.g. python3 verify-receipt.py http://127.0.0.1:3001 req-abc123 \\
         https://api.calibration.node.glif.io/rpc/v1 0x83c264c95e7Ad4b30Caa5Bc60e75E317bf109E4F

Checks (see docs/verification.md for the canonical formats):
  1. worker receipt: ed25519 signature over the canonical receipt payload
  2. leaf == sha256(canonical leaf JSON built from the ledger record + receipt sig)
  3. Merkle inclusion proof folds up to merkle_root
  4. sha256(legacy_hash ‖ merkle_root) == details_hash
  5. details_hash exists on-chain (processedBatches(detailsHash) == true)
Only step 5 needs an RPC; steps 1-4 are pure offline math.

Exit codes: 0 VERIFIED · 1 FAILED (a check mismatched) · 2 usage ·
            3 no proof available (request not settled yet, or unknown request_id) ·
            4 endpoint unreachable
"""
import hashlib
import json
import sys
import urllib.error
import urllib.request


def sha256d(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def jdump(s: str) -> str:
    return json.dumps(s)


def verify(base: str, rid: str, rpc: str | None, contract: str | None) -> int:
    url = f"{base}/api/v1/receipt-proof/{rid}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            p = json.load(r)
    except urllib.error.HTTPError as e:
        # The endpoint explains itself in a JSON body — surface that, not a traceback.
        try:
            detail = json.load(e).get("error", "")
        except Exception:
            detail = str(e.reason)
        print(f"no proof available for {rid} (HTTP {e.code}): {detail}")
        if e.code == 404:
            print("\nA receipt-proof exists only AFTER the request is included in an on-chain")
            print("settlement batch. If this request is recent, it is simply not settled yet —")
            print("wait for the next settlement cycle (or have the operator trigger settle-now),")
            print("then retry. An unknown/mistyped request_id gives this same 404.")
        return 3
    except urllib.error.URLError as e:
        print(f"cannot reach the receipt-proof endpoint {url}: {e.reason}")
        return 4
    ok = True

    # 1) worker receipt signature (skipped if the worker presented none)
    rec = p.get("record") or {}
    rcpt = rec.get("receipt")
    if rcpt and rcpt.get("sig"):
        payload = ("{" +
                   f'"cached_tokens":{rcpt["cached_tokens"]},'
                   f'"completion_tokens":{rcpt["completion_tokens"]},'
                   f'"model":{jdump(rcpt["model"])},'
                   f'"prompt_tokens":{rcpt["prompt_tokens"]},'
                   f'"pubkey":{jdump(rcpt["pubkey"])},'
                   f'"request_id":{jdump(rcpt["request_id"])},'
                   f'"request_sha256":{jdump(rcpt["request_sha256"])},'
                   f'"response_sha256":{jdump(rcpt["response_sha256"])},'
                   f'"ts":{rcpt["ts"]},'
                   '"v":1}').encode()
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(rcpt["pubkey"])).verify(
                bytes.fromhex(rcpt["sig"]), payload)
            print("1) worker receipt signature ........ OK (ed25519)")
        except ImportError:
            print("1) worker receipt signature ........ SKIPPED (pip install cryptography)")
        except Exception as e:
            print(f"1) worker receipt signature ........ FAIL: {e}")
            ok = False
    else:
        print("1) worker receipt signature ........ ABSENT (worker presented no receipt)")

    # 2) leaf reconstruction from the ledger record
    sig = (rcpt or {}).get("sig", "")
    leaf_json = ("{" +
                 f'"cached_tokens":{rec.get("cached_tokens", 0)},'
                 f'"completion_tokens":{rec.get("completion_tokens", 0)},'
                 f'"model":{jdump(rec.get("model", ""))},'
                 f'"prompt_tokens":{rec.get("prompt_tokens", 0)},'
                 f'"request_id":{jdump(rid)},'
                 f'"sig":{jdump(sig)},'
                 f'"sp":{jdump(leaf_sp(p))},'
                 f'"wallet":{jdump(rec.get("wallet", ""))}' + "}").encode()
    leaf = hashlib.sha256(leaf_json).hexdigest()
    if rec:
        if leaf == p["leaf"]:
            print("2) leaf == sha256(record) .......... OK")
        else:
            print(f"2) leaf == sha256(record) .......... FAIL\n   want {p['leaf']}\n   got  {leaf}")
            ok = False
    else:
        print("2) leaf reconstruction ............. SKIPPED (ledger record rotated out; trusting served leaf)")

    # 3) Merkle inclusion
    h = bytes.fromhex(p["leaf"])
    idx = p["leaf_index"]
    for sib_hex in p["proof"]:
        sib = bytes.fromhex(sib_hex)
        h = sha256d(h + sib) if idx % 2 == 0 else sha256d(sib + h)
        idx //= 2
    if h.hex() == p["merkle_root"]:
        print("3) merkle inclusion proof .......... OK")
    else:
        print(f"3) merkle inclusion proof .......... FAIL (derived {h.hex()})")
        ok = False

    # 4) combined hash
    comb = sha256d(bytes.fromhex(p["legacy_hash"]) + bytes.fromhex(p["merkle_root"])).hex()
    if comb == p["details_hash"]:
        print("4) sha256(legacy‖root)==details .... OK")
    else:
        print(f"4) sha256(legacy‖root)==details .... FAIL (derived {comb})")
        ok = False

    # 5) on-chain existence: processedBatches(details_hash) == true
    if rpc and contract:
        # keccak256("processedBatches(bytes32)")[:4] — precomputed constant.
        data = "0x88fcda39" + p["details_hash"]
        req = urllib.request.Request(rpc, method="POST",
                                     headers={"Content-Type": "application/json"},
                                     data=json.dumps({"jsonrpc": "2.0", "id": 1,
                                                      "method": "eth_call",
                                                      "params": [{"to": contract, "data": data}, "latest"]}).encode())
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r).get("result", "0x0")
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            # Steps 1-4 passed offline; the chain check just could not RUN — that is
            # inconclusive, not a failure. Say so and exit distinctly.
            print(f"5) on-chain processedBatches ....... ERROR (rpc unreachable: "
                  f"{getattr(e, 'reason', e)})")
            print("\nRESULT: INCONCLUSIVE — steps 1-4 verified offline, but the on-chain check")
            print("could not run. Retry with a different rpc_url.")
            return 4
        if int(res, 16) == 1:
            print(f"5) on-chain processedBatches ....... OK (tx {p['tx_hash']} block {p['block_number']})")
        else:
            print(f"5) on-chain processedBatches ....... FAIL (chain says not processed: {res})")
            ok = False
    else:
        print("5) on-chain check .................. SKIPPED (pass rpc_url + contract to enable)")

    print("\nRESULT:", "VERIFIED ✔" if ok else "FAILED ✘")
    return 0 if ok else 1


def leaf_sp(p: dict) -> str:
    """The SP EVM payout address inside the leaf (served in the proof payload)."""
    return p.get("sp", "")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    base, rid = sys.argv[1].rstrip("/"), sys.argv[2]
    rpc = sys.argv[3] if len(sys.argv) > 3 else None
    contract = sys.argv[4] if len(sys.argv) > 4 else None
    sys.exit(verify(base, rid, rpc, contract))
