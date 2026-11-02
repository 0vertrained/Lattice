#!/usr/bin/env python3
"""Exercise reviewed handoff over real HTTP, PostgreSQL and scoped credentials.

Requires an EMPTY disposable LATTICE_TEST_DATABASE_URL; scripts/test-handoff.sh
creates one. Bodies and tiny image bytes are transport fixtures, not simulation
or perception evidence. No production resources or credentials are used.
"""
import base64
import concurrent.futures
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa

ROOT = Path(__file__).resolve().parents[1]
CLIENT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
A, B, C = "handoff-rover-a", "handoff-rover-b", "handoff-rover-c"


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


public = PRIVATE.public_key().public_numbers()
JWK = {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "handoff-test-key",
       "n": b64(public.n.to_bytes((public.n.bit_length() + 7) // 8, "big")),
       "e": b64(public.e.to_bytes(3, "big"))}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"keys": [JWK]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def token(role):
    now = int(time.time())
    claims = {"sub": f"handoff-test-{role}", "iss": ISSUER, "aud": "lattice-api",
              "iat": now, "exp": now + 300,
              "realm_access": {"roles": [f"lattice-{role}"]}}
    header = b64(json.dumps({"alg": "RS256", "kid": "handoff-test-key"}).encode())
    payload = b64(json.dumps(claims).encode())
    data = f"{header}.{payload}".encode()
    return f"{data.decode()}.{b64(PRIVATE.sign(data, padding.PKCS1v15(), hashes.SHA256()))}"


def req(path, data=None, credential=None, expected=200):
    headers = {"content-type": "application/json"}
    if credential:
        headers["authorization"] = "Bearer " + credential
    request = urllib.request.Request(BASE + path,
        data=None if data is None else json.dumps(data).encode(), headers=headers)
    try:
        response = CLIENT.open(request, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        assert response.status == expected, (path, response.status, expected, raw[:180])
        return json.loads(raw) if raw and response.headers.get_content_type() == "application/json" else None


def body_input(identity):
    return {"id": identity, "display_name": "Handoff transport fixture", "kind": "rover",
            "capabilities": ["navigate", "inspect"], "adapter_version": "test-1"}


def heartbeat(identity, expected=200):
    return req(f"/v1/bodies/{identity}/heartbeat",
        {"status": "online", "battery": 100 if identity == A else 90,
         "location": "warehouse", "pose": {"x": 0, "y": 0, "yaw": 0}}, devices[identity], expected)


def rows(path):
    return req("/v1/" + path, credential=operator)


def mission(identity):
    return next(item for item in rows("missions") if item["id"] == identity)


def current_round():
    return next(item for item in rows("rounds") if item["id"] == round_id)


def report(item, status, evidence=None, context=None, expected=200, credential=None):
    return req(f'/v1/missions/{item["id"]}/commands/{item["active_command_id"]}/result',
        {"command_id": item["active_command_id"], "body_id": item["assigned_body_id"],
         "status": status, "progress_pct": 100 if status == "succeeded" else 0,
         "detail": "Transport fixture only", "reported_at": datetime.now(timezone.utc).isoformat(),
         "evidence": evidence, "context_digest": context},
        credential or devices[item["assigned_body_id"]], expected)


def evidence(positive):
    # Minimal bytes deliberately test transport/hash rules, never detector accuracy.
    image = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")
    return {"model_id": "handoff-transport-fixture", "captured_at_ms": int(time.time() * 1000),
            "frame_sha256": "a" * 64, "image_sha256": hashlib.sha256(image).hexdigest(),
            "image_base64": base64.b64encode(image).decode(),
            "confidence_domain": "Transport fixture only; no perception accuracy claim",
            "detections": [{"label": "octagonal_safety_marker", "confidence": .91,
                            "box": [12, 12, 30, 30]}] if positive else []}


def approve(handoff, expected=200, digest=None, credential=None):
    return req(f'/v1/handoffs/{handoff["id"]}/approve',
               {"digest": digest or handoff["digest"]}, credential or operator, expected)


def prepare():
    return req(f"/v1/rounds/{round_id}/handoff-proposal", {"target_body_id": B}, operator, 201)


def next_command(identity, expected=200):
    return req(f"/v1/bodies/{identity}/commands/next", credential=devices[identity], expected=expected)


def verify_signature(command, public_key):
    payload = json.dumps(command["envelope"], separators=(",", ":"), ensure_ascii=False).encode()
    ed25519.Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key["public_key_base64"])).verify(
        base64.b64decode(command["signature_base64"]), payload)


server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
ISSUER = f"http://127.0.0.1:{server.server_port}"
threading.Thread(target=server.serve_forever, daemon=True).start()
PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"
with tempfile.TemporaryDirectory(prefix="lattice-handoff-http-") as directory:
    work = Path(directory)
    key = work / "signing.key"
    key.write_bytes(secrets.token_bytes(32))
    key.chmod(0o600)
    env = {**os.environ, "LATTICE_AUTH_MODE": "oidc", "LATTICE_OIDC_ISSUER": ISSUER,
           "LATTICE_OIDC_JWKS_URL": ISSUER + "/jwks", "LATTICE_OIDC_AUDIENCE": "lattice-api",
           "LATTICE_OIDC_CLIENT_ID": "lattice-ui", "LATTICE_BIND_ADDRESS": f"127.0.0.1:{PORT}",
           "LATTICE_DATABASE_URL": os.environ["LATTICE_TEST_DATABASE_URL"],
           "LATTICE_SIGNING_KEY_FILE": str(key), "LATTICE_COMMAND_TTL_SECONDS": "5",
           "LATTICE_HEARTBEAT_TIMEOUT_SECONDS": "2",
           "NO_PROXY": os.environ.get("NO_PROXY", "") + ",localhost,127.0.0.1"}
    for name in ("LATTICE_SIGNING_SEED_BASE64", "LATTICE_ALLOW_CORE_TAKEOVER", "LATTICE_DEV_API_KEY"):
        env.pop(name, None)
    process = None
    log = (work / "core.log").open("w+")

    def start():
        global process
        process = subprocess.Popen([str(ROOT / "target/debug/lattice-core-api")],
            env=env, stdout=log, stderr=log)
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError("Disposable core exited during startup (no credentials logged)")
            try:
                req("/ready")
                return
            except (OSError, AssertionError):
                time.sleep(.05)
        raise AssertionError("Disposable core readiness timed out")

    def crash():
        process.kill()
        process.wait(timeout=5)

    try:
        start()
        admin, operator, viewer = token("admin"), token("operator"), token("viewer")
        devices = {}
        for identity in (A, B, C):
            devices[identity] = req("/v1/devices", {"body_id": identity,
                "label": "Handoff test fixture", "expires_in_days": 1}, admin, 201)["token"]
            req("/v1/bodies/register", body_input(identity), devices[identity], 201)
        heartbeat(A)
        heartbeat(B)
        # Keep C available only as an unauthorized caller, never as a preferred target.
        req(f"/v1/bodies/{C}/heartbeat", {"status": "faulted", "battery": 90,
            "location": "warehouse", "pose": None}, devices[C])
        public_key = req("/v1/security/verification-key", credential=devices[A])
        steps = [
            {"title": "Observe marker before transfer", "command": {"type": "inspect", "location": "inspection_bay"}, "continue_on_missing_marker": False},
            {"title": "Continue interrupted travel", "command": {"type": "navigate", "destination": "loading_dock", "max_speed_mps": .3}, "continue_on_missing_marker": False},
            {"title": "Retain later counter evidence", "command": {"type": "inspect", "location": "inspection_bay"}, "continue_on_missing_marker": True},
            {"title": "Finish on transferred body", "command": {"type": "navigate", "destination": "charging_station", "max_speed_mps": .3}, "continue_on_missing_marker": False},
        ]
        proposed = req("/v1/rounds", {"steps": steps}, operator, 201)
        round_id = proposed["id"]
        running = req(f"/v1/rounds/{round_id}/approve", {"digest": proposed["digest"]}, operator)
        first = mission(running["current_mission_id"])
        assert first["assigned_body_id"] == A
        verify_signature(next_command(A), public_key)
        positive = evidence(True)
        report(first, "succeeded", positive)
        report(first, "succeeded", positive)
        observation = rows("observations")[0]
        assert observation["body_id"] == A and observation["mission_id"] == first["id"]
        assert len(rows("observations")) == 1
        original = req(f'/v1/observations/{observation["id"]}/evidence', credential=viewer)
        assert original == positive
        req("/v1/observations", credential=devices[A], expected=403)
        current = current_round()
        assert current["current_step"] == 1 and current["assigned_body_id"] == A
        source = mission(current["current_mission_id"])
        source_command = next_command(A)
        report(source, "running")
        req(f"/v1/rounds/{round_id}/handoff-proposal", {"target_body_id": B}, viewer, 403)
        req(f"/v1/rounds/{round_id}/handoff-proposal", {"target_body_id": B}, devices[A], 403)
        req(f"/v1/rounds/{round_id}/handoff-proposal", {"target_body_id": A}, operator, 422)
        review = prepare()
        assert len(review["completed_steps"]) == 1 and len(review["remaining_steps"]) == 3
        assert review["retained_observation_ids"] == [observation["id"]]
        approve(review, 422, digest="0" * 64)
        approve(review, 403, credential=viewer)
        approve(review, 422)
        heartbeat(A, 422)
        req("/v1/bodies/register", body_input(A), devices[A], 422)
        next_command(A, 422)
        next_command(B, 204)
        assert report(source, "succeeded")["status"] == "recovery_required"
        recovery = req(f'/v1/missions/{source["id"]}/recovery-proposal', {}, operator, 201)
        req(f'/v1/proposals/{recovery["id"]}/approve', {"digest": recovery["digest"]}, operator, 422)
        competing = prepare()
        approve(review, 422)
        assert next(item for item in rows("handoffs") if item["id"] == review["id"])["status"] == "invalidated"
        crash()
        start()
        assert next(item for item in rows("handoffs") if item["id"] == competing["id"])["status"] == "invalidated"
        assert rows("observations")[0] == observation
        assert current_round()["status"] == "recovery_required"
        heartbeat(A, 422)
        next_command(A, 422)
        approve(competing, 422)
        heartbeat(B)
        review = prepare()
        assert review["not_before_at"] == competing["not_before_at"]
        deadline = datetime.fromisoformat(review["not_before_at"].replace("Z", "+00:00")).timestamp()
        assert deadline - time.time() <= 8
        while time.time() < deadline + .05:
            heartbeat(B)
            time.sleep(min(.25, max(.01, deadline + .05 - time.time())))
        # An eligible body at proposal time must still be fresh when approved.
        time.sleep(2.1)
        approve(review, 422)
        heartbeat(B)
        recovery = req(f'/v1/missions/{source["id"]}/recovery-proposal', {}, operator, 201)
        req(f'/v1/proposals/{recovery["id"]}/approve', {"digest": recovery["digest"]}, operator, 422)
        # Busy target is rechecked without consuming the review.
        task = req("/v1/proposals", {"title": "Occupy target to test approval", "command": steps[1]["command"]}, operator, 201)
        busy = req(f'/v1/proposals/{task["id"]}/approve', {"digest": task["digest"]}, operator)
        assert busy["assigned_body_id"] == B
        next_command(B)
        approve(review, 422)
        report(busy, "succeeded")
        req(f'/v1/handoffs/{review["id"]}/approve', {"digest": review["digest"], "target_body_id": C}, operator, 422)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            approvals = list(pool.map(lambda _: approve(review), range(4)))
        assert len({item["resumed_mission_id"] for item in approvals}) == 1
        accepted = approvals[0]
        resumed = mission(accepted["resumed_mission_id"])
        assert resumed["assigned_body_id"] == B and resumed["command"] == source["command"]
        assert report(source, "succeeded")["status"] == "cancelled"
        command = next_command(B)
        verify_signature(command, public_key)
        assert command["envelope"]["continuation"] == review["context"]
        assert command["envelope"]["command_id"] != source_command["envelope"]["command_id"]
        next_command(B, 204)
        context = review["context"]["digest"]
        evidence_path = f'/v1/bodies/{B}/missions/{resumed["id"]}/observations/{observation["id"]}/evidence'
        req(evidence_path, credential=devices[C], expected=403)
        req(evidence_path.replace(f"/bodies/{B}/", f"/bodies/{C}/"), credential=devices[C], expected=403)
        req(evidence_path, credential=operator, expected=403)
        req(evidence_path.replace(observation["id"], "observation-unrelated"), credential=devices[B], expected=403)
        retained = req(evidence_path, credential=devices[B])
        assert retained["observation"] == observation and retained["evidence"] == original
        assert hashlib.sha256(base64.b64decode(retained["evidence"]["image_base64"])).hexdigest() == review["context"]["observations"][0]["image_sha256"]
        report(resumed, "running", expected=422)
        report(resumed, "running", context="0" * 64, expected=422)
        report(resumed, "running", context=context)
        assert next(item for item in rows("handoffs") if item["id"] == review["id"])["context_acknowledged_at"] is not None
        heartbeat(A)  # Its old command expired; returning A must not steal the round.
        heartbeat(B)
        report(resumed, "succeeded", context=context)
        report(resumed, "succeeded", context=context)
        req(evidence_path, credential=devices[B], expected=403)
        third = mission(current_round()["current_mission_id"])
        assert current_round()["current_step"] == 2 and third["assigned_body_id"] == B
        assert next_command(B)["envelope"]["continuation"]["digest"] == context
        negative = evidence(False)
        report(third, "failed", negative, context)
        final = mission(current_round()["current_mission_id"])
        assert final["assigned_body_id"] == B and current_round()["current_step"] == 3
        assert next_command(B)["envelope"]["continuation"]["digest"] == context
        report(final, "succeeded", context=context)
        report(final, "succeeded", context=context)
        done = current_round()
        assert done["status"] == "completed" and len(done["mission_ids"]) == 5
        assert done["anomaly_count"] == 1
        next_command(A, 204)
        next_command(B, 204)
        last = rows("observations/last-seen?subject=safety-marker%3Ainspection_bay")
        assert last["last_seen"]["id"] == observation["id"]
        assert last["later_negative"]["body_id"] == B
        assert len(rows("observations")) == 2
        assert len(rows("observations?limit=1")) == 1
        req("/v1/observations?limit=101", credential=viewer, expected=422)
        memory_before = rows("observations")
        receipt_before = next(item for item in rows("handoffs") if item["id"] == review["id"])
        crash()
        start()
        assert rows("observations") == memory_before
        assert next(item for item in rows("handoffs") if item["id"] == review["id"]) == receipt_before
        assert current_round()["status"] == "completed"
        assert req(f'/v1/observations/{observation["id"]}/evidence', credential=viewer) == original
        print("PASS: scoped HTTP handoff, immutable concurrent approval, source fences across restart, stale/busy target rejection, evidence delivery/hash, required context receipt, suffix pinned to B, late-result isolation, last-seen counter-evidence and durable history")
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        server.shutdown()
        server.server_close()
        log.close()
