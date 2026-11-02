#!/usr/bin/env python3
"""Exercise adaptive continuity over real HTTP, PostgreSQL and scoped credentials.

Requires an EMPTY disposable LATTICE_TEST_DATABASE_URL; scripts/test-adaptive.sh
creates one. Bodies and tiny image bytes are transport fixtures, not simulation
or perception evidence. No production resources or credentials are used.
"""
import base64
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
A, B, C = "adaptive-robot-a", "adaptive-robot-b", "adaptive-robot-c"


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


public = PRIVATE.public_key().public_numbers()
JWK = {"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "adaptive-test-key",
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
    claims = {"sub": f"adaptive-test-{role}", "iss": ISSUER, "aud": "lattice-api",
              "iat": now, "exp": now + 300,
              "realm_access": {"roles": [f"lattice-{role}"]}}
    header = b64(json.dumps({"alg": "RS256", "kid": "adaptive-test-key"}).encode())
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
    return {"id": identity, "display_name": "Adaptive transport fixture", "kind": "quadruped" if identity == B else "rover",
            "capabilities": ["navigate", "inspect", "stairs"] if identity == B else ["navigate", "inspect"], "adapter_version": "test-1"}


def heartbeat(identity, expected=200):
    return req(f"/v1/bodies/{identity}/heartbeat",
        {"status": "faulted" if identity == C else "online", "battery": 100,
         "location": "warehouse", "pose": poses[identity]}, devices[identity], expected)


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
    return {"model_id": "adaptive-transport-fixture", "captured_at_ms": int(time.time() * 1000),
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
poses = {A: {"x": 0., "y": 2.5, "yaw": 0.},
         B: {"x": 1., "y": -2., "yaw": 0., "z": 0.},
         C: {"x": 0., "y": 2.5, "yaw": 0.}}
with tempfile.TemporaryDirectory(prefix="lattice-adaptive-http-") as directory:
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
           "LATTICE_NAVIGATION_MAP_FILE": str(ROOT / "simulation/routes/warehouse-adaptive.json"),
           "NO_PROXY": os.environ.get("NO_PROXY", "") + ",localhost,127.0.0.1"}
    for name in ("LATTICE_SIGNING_SEED_BASE64", "LATTICE_ALLOW_CORE_TAKEOVER", "LATTICE_DEV_API_KEY"):
        env.pop(name, None)
    process = None
    log = (work / "core.log").open("w+")

    def start():
        global process
        process = subprocess.Popen([str(ROOT / "target/debug/lattice-core-api")], env=env, stdout=log, stderr=log)
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

    def wait_fence(at):
        deadline = datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
        assert deadline - time.time() < 9, "Fixture must retain the bounded signed expiry, not invent a long fence"
        while time.time() < deadline + .05:
            heartbeat(B)
            time.sleep(min(.2, max(.01, deadline + .05 - time.time())))
        heartbeat(A)
        heartbeat(B)

    def route(inspect_source=True):
        heartbeat(A)
        heartbeat(B)
        proposal = req("/v1/navigation/plans", {"route": {
            "source_body_id": A, "source_place_id": "inspection_bay", "destination_place_id": "upper_inspection",
            "destination_capability": "inspect"}, "inspect_source": inspect_source, "inspect_destination": True}, operator, 201)
        assert proposal["status"] == "pending"
        return req(f'/v1/navigation/plans/{proposal["id"]}/approve', {"digest": proposal["digest"]}, operator)

    def replan():
        held = current_round()
        return req(f'/v1/rounds/{round_id}/replan-proposal', {"digest": held["digest"]}, operator, 201)

    def approve_replan(review, expected=200, credential=None):
        return req(f'/v1/replans/{review["id"]}/approve', {"digest": review["digest"]}, credential or operator, expected)

    try:
        start()
        admin, operator, viewer = token("admin"), token("operator"), token("viewer")
        devices = {}
        for identity in (A, B, C):
            devices[identity] = req("/v1/devices", {"body_id": identity,
                "label": "Adaptive test fixture", "expires_in_days": 1}, admin, 201)["token"]
            req("/v1/bodies/register", body_input(identity), devices[identity], 201)
            heartbeat(identity)
        public_key = req("/v1/security/verification-key", credential=devices[A])
        req("/v1/navigation/conditions", expected=401)
        req("/v1/replans", credential=devices[A], expected=403)
        req("/v1/navigation/conditions", {}, viewer, 403)
        req("/v1/navigation/conditions", {}, devices[A], 403)
        initial = route()
        round_id = initial["id"]
        original_digest = initial["digest"]
        first = mission(initial["current_mission_id"])
        verify_signature(next_command(A), public_key)
        positive = evidence(True)
        report(first, "succeeded", positive)
        observation = rows("observations")[0]
        original_image = req(f'/v1/observations/{observation["id"]}/evidence', credential=viewer)
        current = current_round()
        assert current["current_step"] == 1
        source = mission(current["current_mission_id"])
        signed = next_command(A)
        traversal = signed["envelope"]["command"]["traversal"]
        assert traversal["segment_id"] == "bay_to_transfer"
        report(source, "running")
        body_condition = {"event_id": "adaptive-fixture-scan", "map_digest": traversal["map_digest"],
            "segment_id": "bay_to_transfer", "status": "blocked", "reason": "Measured fixture scan blocks direct corridor",
            "observed_at": datetime.now(timezone.utc).isoformat(), "command_id": source["active_command_id"],
            "evidence": {"sensor": "laser_scan", "frame_id": "map", "distance_m": .65,
                "blocked_samples": 8, "scan_sha256": hashlib.sha256(b"explicit transport scan fixture").hexdigest(),
                "observer_pose": poses[A]}}
        body_path = f"/v1/bodies/{A}/route-conditions"
        req(body_path, body_condition, devices[C], 403)
        req(body_path, body_condition, operator, 403)
        req(body_path.replace(A, C), body_condition, devices[C], 422)
        req(body_path, {**body_condition, "command_id": "command-unrelated"}, devices[A], 422)
        req(body_path, {**body_condition, "map_digest": "0" * 64}, devices[A], 422)
        wrong_pose = {**body_condition["evidence"], "observer_pose": {"x": 8, "y": 8, "yaw": 0}}
        req(body_path, {**body_condition, "evidence": wrong_pose}, devices[A], 422)
        heartbeat(A)
        recorded = req(body_path, body_condition, devices[A], 201)
        assert req(body_path, body_condition, devices[A], 201) == recorded
        assert rows("navigation/conditions")["blocked_segment_ids"] == ["bay_to_transfer"]
        assert current_round()["status"] == "recovery_required"
        review = replan()
        assert review["status"] == "pending", review.get("failure")
        assert review["completed_steps"] == initial["steps"][:1]
        assert review["retained_observation_ids"] == [observation["id"]]
        assert review["step_body_ids"] == [A, A, B, B]
        assert [s["command"]["traversal"]["segment_id"] for s in review["remaining_steps"][:-1]] == [
            "bay_to_west_bypass", "west_bypass_to_transfer", "stairs_to_upper"]
        assert not any(s["command"] == first["command"] for s in review["remaining_steps"])
        approve_replan(review, 403, viewer)
        approve_replan(review, 422)
        req(f'/v1/replans/{review["id"]}/approve', {"digest": review["digest"], "remaining_steps": []}, operator, 422)
        req(f'/v1/rounds/{round_id}/replan-proposal', {"digest": original_digest, "destination": "charging_station"}, operator, 422)
        next_command(A, 422)
        next_command(B, 204)
        assert report(source, "succeeded")["status"] == "recovery_required"
        manual_clear = {"event_id": "adaptive-fixture-clear", "map_digest": traversal["map_digest"],
            "segment_id": "bay_to_transfer", "status": "clear", "reason": "Operator fixture clear after review",
            "observed_at": datetime.now(timezone.utc).isoformat(), "expected_revision": recorded["revision"] - 1}
        req("/v1/navigation/conditions", manual_clear, operator, 422)
        wait_fence(review["not_before_at"])
        # Idempotent retry must still work after the original five-second report window.
        assert req(body_path, body_condition, devices[A], 201) == recorded
        continued = approve_replan(review)
        assert continued["id"] == round_id and continued["digest"] != original_digest
        assert continued["steps"][0] == initial["steps"][0] and continued["current_step"] == 1
        assert continued["mission_ids"][:2] == [first["id"], source["id"]]
        same = approve_replan(review)
        assert same["current_mission_id"] == continued["current_mission_id"]
        for target in [("west_bypass", -2., 2.2), ("stair_transfer", 1., -2.)]:
            leg = mission(current_round()["current_mission_id"])
            command = next_command(A)
            assert command["envelope"]["command"]["traversal"]["to"]["id"] == target[0]
            poses[A] = {"x": target[1], "y": target[2], "yaw": 0.}
            heartbeat(A)
            heartbeat(B)
            report(leg, "succeeded")
        held = current_round()
        assert held["current_step"] == 3 and held["status"] == "recovery_required"
        options = rows(f"rounds/{round_id}/transfer-options")
        assert options["required"] and options["recommended_target_body_id"] == B
        handoff = prepare()
        assert handoff["retained_observation_ids"] == [observation["id"]]
        assert len(handoff["completed_steps"]) == 3
        approve(handoff, 422)
        wait_fence(handoff["not_before_at"])
        accepted = approve(handoff)
        target = mission(accepted["resumed_mission_id"])
        next_command(B)
        context = accepted["context"]["digest"]
        path = f'/v1/bodies/{B}/missions/{target["id"]}/observations/{observation["id"]}/evidence'
        req(path, credential=devices[C], expected=403)
        retained = req(path, credential=devices[B])
        assert retained["evidence"] == original_image
        assert hashlib.sha256(base64.b64decode(retained["evidence"]["image_base64"])).hexdigest() == observation["image_sha256"]
        report(target, "running", expected=422)
        report(target, "running", context=context)
        poses[B] = {"x": 4.5, "y": -2., "z": .15, "yaw": 0.}
        heartbeat(B)
        report(target, "succeeded", context=context)
        last = mission(current_round()["current_mission_id"])
        next_command(B)
        report(last, "succeeded", evidence(True), context)
        done = current_round()
        assert done["status"] == "completed" and len(done["steps"]) == 5
        assert len([m for m in rows("missions") if m["id"] in done["mission_ids"] and m["command"] == first["command"]]) == 1
        assert next(o for o in rows("observations") if o["id"] == observation["id"]) == observation
        memory_before = rows("observations")
        assert len(memory_before) == 2
        manual_clear.update(observed_at=datetime.now(timezone.utc).isoformat(), expected_revision=recorded["revision"])
        cleared = req("/v1/navigation/conditions", manual_clear, operator, 201)
        assert not rows("navigation/conditions")["blocked_segment_ids"]

        # A separate round proves the background monitor acts without UI reads or reassign calls.
        completed_round_id = round_id
        poses[A] = {"x": 0., "y": 2.5, "yaw": 0.}
        poses[B] = {"x": 1., "y": -2., "z": 0., "yaw": 0.}
        running = route(inspect_source=False)
        round_id = running["id"]
        interrupted = mission(running["current_mission_id"])
        next_command(A)
        report(interrupted, "running")
        last_heartbeat = time.monotonic()
        while time.monotonic() - last_heartbeat < 3.3:
            heartbeat(B)  # No reads, no A heartbeat, no explicit reassignment.
            time.sleep(.2)
        held = current_round()
        assert held["status"] == "recovery_required", "Background monitor did not retain unavailable work"
        assert mission(interrupted["id"])["status"] == "recovery_required"
        records = [a for a in rows("audit") if a["event_type"] == "route.body_unavailable" and a["object_id"] == interrupted["id"]]
        assert len(records) == 1, "Monitor holds should be idempotent"
        unavailable = replan()
        assert unavailable["status"] == "blocked" and unavailable["failure"]
        wait_fence(unavailable["not_before_at"])
        pending = replan()
        assert pending["status"] == "pending"
        assert pending["retained_mission_ids"] == held["mission_ids"]
        crash()
        start()
        assert next(r for r in rows("replans") if r["id"] == pending["id"])["status"] == "invalidated"
        assert current_round()["status"] == "recovery_required"
        assert next(r for r in rows("rounds") if r["id"] == completed_round_id)["status"] == "completed"
        assert rows("observations") == memory_before
        assert rows("navigation/conditions")["revision"] == cleared["revision"]
        assert not rows("navigation/conditions")["blocked_segment_ids"]
        approve_replan(pending, 422)
        heartbeat(B)
        next_command(B, 204)
        print("PASS: scoped adaptive HTTP evidence, command/map/pose binding, idempotent late retry, stale-clear rejection, immutable reviewed detour, complete source fence, retained same-round inspection, explicit handoff/context receipt, automatic body-loss hold without UI reads, and restart retention/invalidation")
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
