#!/usr/bin/env python3
"""Offline verifier for OpenModel verifiable billing (design-improvement A1).

Anyone holding a request_id can verify — WITHOUT trusting the operator — that the
charge settled on-chain matches what the worker attested:

    python3 verify-receipt.py [--ca ca.pem | --insecure] <public_query_base> <request_id> [rpc_url] [contract]

e.g. python3 verify-receipt.py http://127.0.0.1:3001 req-abc123 \\
         https://api.calibration.node.glif.io/rpc/v1 0x97a3d202CfF60dD369cdf8F7D514dAe36b469852

Pass --ca <file> (the CA certificate distributed alongside the endpoint) or
--insecure (skip TLS verification for this fetch) only when the endpoint's
certificate is outside the system trust store — e.g. a self-hosted gateway on
a private CA. The proof itself stays tamper-evident either way: checks 1-5
are cryptographic, not transport trust.
These flags affect only the receipt-proof fetch — the rpc_url connection always
uses normal system trust.

Checks (canonical byte-level formats: docs/verification.md in this repo):
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
import ssl
import sys
import urllib.error
import urllib.request


def gateway_ssl_context(insecure: bool, cafile: str | None) -> ssl.SSLContext | None:
    """TLS context for the receipt-proof fetch only (None = default trust)."""
    if insecure:
        return ssl._create_unverified_context()
    if cafile:
        # A private-CA endpoint identifies itself by its stable gateway_id, not
        # by hostname/IP — so pin the chain to the distributed CA and skip
        # hostname matching. An impostor would still need the CA's private key.
        ctx = ssl.create_default_context(cafile=cafile)
        ctx.check_hostname = False
        return ctx
    return None


def sha256d(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def jdump(s: str) -> str:
    return json.dumps(s)


def verify(base: str, rid: str, rpc: str | None, contract: str | None,
           ctx: ssl.SSLContext | None = None) -> int:
    url = f"{base}/api/v1/receipt-proof/{rid}"
    try:
        with urllib.request.urlopen(url, timeout=30, context=ctx) as r:
            p = json.load(r)
    except urllib.error.HTTPError as e:
        # The endpoint explains itself in a JSON body — surface that, not a traceback.
        try:
            detail = json.load(e).get("error", "")
        except Exception:
            detail = str(e.reason)
        print(f"no proof available for {rid} (HTTP {e.code}): {detail}")
        if e.code == 404:
            print("\n404 now means the id has NO billing record at all (a recent-but-unsettled")
            print("request answers 202/pending instead). Check the request_id for typos; very old")
            print("requests can also rotate out of the billing log.")
        return 3
    except urllib.error.URLError as e:
        print(f"cannot reach the receipt-proof endpoint {url}: {e.reason}")
        return 4

    # HTTP 202: billed and recorded, but the settlement batch is not on-chain
    # yet. urlopen does NOT raise for 2xx, so without this branch the pending
    # body would fall through into the five checks and fail on missing fields —
    # reading like a broken proof when it is only a queue position.
    if p.get("status") == "pending_settlement":
        eta = int(p.get("next_settlement_eta_sec") or 0)
        print(f"PENDING: {rid} is billed but its settlement batch is not committed yet.")
        print(f"         next settlement pass in ~{eta // 60}m {eta % 60}s — retry then for the full proof.")
        wr = p.get("worker_receipt")
        if wr and wr.get("sig"):
            print("         the worker-signed receipt is already present "
                  f"(pubkey {str(wr.get('pubkey'))[:16]}…) — checks 3-5 (Merkle/on-chain/amount)")
            print("         become possible only after settlement.")
        return 3
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
            # The signature is the root of the whole trust chain: a verifier
            # that skips it must not print VERIFIED. Fail loudly instead.
            print("1) worker receipt signature ........ FAIL: the `cryptography` package is not installed (pip install cryptography)")
            ok = False
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
    # A request settled as CARRIED DEBT commits an identity-only leaf: at settlement
    # time its billing record had already passed the scan cursor, so the Merkle tree
    # binds {debt, request_id, sp, wallet} and nothing else. The served record (from
    # the ledger index) is informational there — token counts are NOT part of the
    # on-chain commitment for such a request, and this check must say so honestly.
    debt_json = ("{" +
                 '"debt":true,'
                 f'"request_id":{jdump(rid)},'
                 f'"sp":{jdump(leaf_sp(p))},'
                 f'"wallet":{jdump(rec.get("wallet", ""))}' + "}").encode()
    debt_leaf = hashlib.sha256(debt_json).hexdigest()
    if rec:
        if leaf == p["leaf"]:
            print("2) leaf == sha256(record) .......... OK")
        elif debt_leaf == p["leaf"]:
            print("2) leaf == sha256(record) .......... OK (debt leaf: identity-only commitment;"
                  " settled as carried debt, token counts not covered)")
        else:
            print(f"2) leaf == sha256(record) .......... FAIL\n   want {p['leaf']}\n   got  {leaf} (receipt form) / {debt_leaf} (debt form)")
            ok = False
    else:
        if debt_leaf == p["leaf"]:
            print("2) leaf reconstruction ............. OK (debt leaf: identity-only commitment)")
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
    argv, insecure, cafile = [], False, None
    it = iter(sys.argv[1:])
    for a in it:
        if a == "--insecure":
            insecure = True
        elif a == "--ca":
            cafile = next(it, None)
            if not cafile:
                print("--ca needs a certificate file path")
                sys.exit(2)
        else:
            argv.append(a)
    if len(argv) < 2:
        print(__doc__)
        sys.exit(2)
    base, rid = argv[0].rstrip("/"), argv[1]
    rpc = argv[2] if len(argv) > 2 else None
    contract = argv[3] if len(argv) > 3 else None
    sys.exit(verify(base, rid, rpc, contract,
                    ctx=gateway_ssl_context(insecure, cafile)))
