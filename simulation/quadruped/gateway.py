#!/usr/bin/env python3
"""Private, fail-closed Lattice gateway for the bounded MuJoCo Go1 stair scene.

The Rust body verifies signed commands and retained handoff evidence. This local
process independently verifies the reviewed map, pose, wall-clock lease and
physical arrival. Physics continues when idle, stopped and failed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import struct
import threading
import time


CAPABILITY_ORDER = ("navigate", "inspect", "follow", "carry", "stairs", "aerial", "rough_terrain")
CAPABILITIES = {"navigate", "inspect", "stairs"}


def distance(a, b):
    return math.sqrt(sum((float(a[k]) - float(b[k])) ** 2 for k in ("x", "y", "z")))


def endpoint(place):
    return {key: place[key] for key in ("id", "pose", "arrival_radius_m")}


def f32(value):
    """Route speed is Rust f32; serde_json::Value may expand its decimal."""
    return struct.unpack("!f", struct.pack("!f", float(value)))[0]


def map_digest(value):
    """Match SemanticMap::digest's struct order and sorted collection order.

    Coordinates/radii are f64, speed bounds f32 represented by their reviewed
    JSON decimal. The map installer must cross-check this against the core API.
    """
    places = [{"id": p["id"], "label": p["label"],
               "pose": {k: float(p["pose"][k]) for k in ("x", "y", "z")},
               "arrival_radius_m": float(p["arrival_radius_m"]),
               "transfer_allowed": p["transfer_allowed"]}
              for p in sorted(value["places"], key=lambda p: p["id"])]
    segments = [{"id": s["id"], "from": s["from"], "to": s["to"],
                 "required_capabilities": sorted(s["required_capabilities"], key=CAPABILITY_ORDER.index),
                 "max_speed_mps": float(s["max_speed_mps"]), "enabled": s["enabled"]}
                for s in sorted(value["segments"], key=lambda s: s["id"])]
    canonical = {"id": value["id"], "revision": value["revision"],
                 "frame_id": value["frame_id"], "places": places, "segments": segments}
    return hashlib.sha256(json.dumps(canonical, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


class Gateway:
    def __init__(self, controller, semantic_map, run_dir, monotonic=time.monotonic, utc=time.time):
        self.controller = controller
        self.map = semantic_map
        self.digest = map_digest(semantic_map)
        self.places = {p["id"]: p for p in semantic_map["places"]}
        self.segments = {s["id"]: s for s in semantic_map["segments"]}
        self.run_dir = Path(run_dir)
        self.monotonic, self.utc = monotonic, utc
        self.lock = threading.RLock()
        self.state, self.command_id, self.detail = "idle", "", "standing; waiting for signed authorization"
        self.progress = 0
        self.lease_at = -math.inf
        self.pose_at = -math.inf
        self.deadline = -math.inf
        self.expires_unix_ms = 0
        self.estop = False
        self.goal = None
        self.inspection = False
        self.seen = set()
        self.braking = False
        self.stable_since = None
        self.arrived_at = None
        self.initial_distance = 0.0
        self.speed = 0.0
        self.best_distance = math.inf
        self.progress_at = monotonic()
        self.physics_started = monotonic()
        self.fault_latched = None
        self.controller.brake()

    def ready(self):
        return (not self.estop and not self.controller.fallen and
                self.monotonic() - self.pose_at < .25 and
                self.monotonic() - self.physics_started >= 1.0)

    def status(self, ok=True, detail=None):
        return {"ok": ok, "ready": self.ready(), "state": self.state,
                "command_id": self.command_id, "detail": detail or self.detail,
                "pose": self.controller.pose, "progress_pct": self.progress,
                "physics": self.controller.metrics,
                "map_digest": self.digest}

    def stop(self, reason, invalidate_success=False):
        self.controller.brake()
        self.braking = True
        if self.state == "running" or invalidate_success and self.state == "succeeded":
            self.state, self.detail = "failed", reason

    def supported(self):
        metrics = self.controller.metrics
        contacts = metrics.get("foot_contacts", [])
        return (len({contact["foot"] for contact in contacts if contact["normal_force_n"] > 1.0}) >= 3 and
                metrics.get("tilt", math.inf) < .35 and
                abs(metrics.get("velocity", [0, 0, math.inf])[2]) < .05)

    def capture_ready(self, command_id):
        now = self.monotonic()
        return (self.state == "succeeded" and self.inspection and command_id == self.command_id and
                self.ready() and self.goal is not None and now < self.deadline and
                now - self.lease_at <= 1.5 and int(self.utc() * 1000) < self.expires_unix_ms and
                distance(self.controller.pose, self.goal["pose"]) <= self.goal["arrival_radius_m"] and
                self.controller.speed < .045 and self.supported())

    def fault(self, now):
        if self.estop:
            return "emergency stop"
        if self.controller.fallen:
            return "physical stability/contact fault"
        if self.state != "running":
            return None
        if now >= self.deadline or int(self.utc() * 1000) >= self.expires_unix_ms:
            return "signed command expired"
        if now - self.lease_at > 1.5:
            return "core/body connection watchdog"
        if now - self.pose_at > .25:
            return "physics localization watchdog"
        return self.fault_latched

    def watchdog(self):
        """Separate wall-clock watchdog; never renews a lease or advances physics."""
        with self.lock:
            fault = self.fault(self.monotonic())
            if fault:
                self.stop(fault, invalidate_success=self.controller.fallen or self.estop)

    def request(self, value):
        with self.lock:
            try:
                return self._request(value)
            except (KeyError, ValueError, TypeError, OverflowError, RuntimeError) as error:
                return self.status(False, str(error))

    def _request(self, value):
        op = value["op"]
        now = self.monotonic()
        if op == "status":
            return self.status()
        if op == "lease":
            self.lease_at = now
            return self.status()
        if op == "stop":
            self.stop("body agent stopped")
            return self.status()
        if op == "emergency_stop":
            self.estop = bool(value.get("active", True))
            if self.estop:
                self.stop("emergency stop")
            return self.status()
        if op == "capture":
            if not self.capture_ready(value["command_id"]):
                raise ValueError("fresh authorized post-arrival camera unavailable")
            filename = self.command_id + ".ppm"
            self.controller.render_ppm(self.run_dir / filename)
            timestamp = int(self.utc() * 1000)
            if not self.capture_ready(value["command_id"]):
                (self.run_dir / filename).unlink(missing_ok=True)
                raise ValueError("camera capture exceeded authorization or physical stability bounds")
            return self.status() | {"capture_file": filename, "capture_unix_ms": timestamp}
        if op not in ("traverse_route", "navigate"):
            raise ValueError("unknown local operation")
        if self.state == "running":
            raise ValueError("navigation already active")
        if not self.ready() or now - self.lease_at > 1.5:
            raise ValueError("physics/lease not ready")
        command_id = value["command_id"]
        if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", command_id) or command_id in self.seen:
            raise ValueError("invalid or replayed command identity")
        remaining = min(int(value["ttl_ms"]), int(value["expires_unix_ms"]) - int(self.utc() * 1000))
        speed = float(value["max_speed_mps"])
        if remaining <= 0 or remaining > 300000 or not math.isfinite(speed) or not f32(.05) <= f32(speed) <= f32(.3):
            raise ValueError("local lifetime/speed policy rejected command")
        destination = value["destination"]
        if destination not in self.places:
            raise ValueError("unknown reviewed destination")
        goal = self.places[destination]
        if op == "traverse_route":
            snapshot = value["traversal"]
            if (snapshot["map_id"] != self.map["id"] or snapshot["map_revision"] != self.map["revision"] or
                    snapshot["map_digest"] != self.digest):
                raise ValueError("stale semantic map snapshot")
            segment = self.segments.get(snapshot["segment_id"])
            if segment is None or not segment["enabled"]:
                raise ValueError("unknown or disabled route segment")
            source = self.places[segment["from"]]
            if (snapshot["from"] != endpoint(source) or snapshot["to"] != endpoint(goal) or segment["to"] != destination or
                    snapshot["required_capabilities"] != segment["required_capabilities"] or
                    f32(snapshot["max_speed_mps"]) != f32(segment["max_speed_mps"]) or f32(speed) > f32(segment["max_speed_mps"]) or
                    not set(segment["required_capabilities"]).issubset(CAPABILITIES)):
                raise ValueError("route differs from reviewed geometry or capabilities")
            if distance(self.controller.pose, source["pose"]) > source["arrival_radius_m"]:
                raise ValueError("body is not currently at route source")
            # This simulator certifies one physical stair corridor, not arbitrary
            # routes represented by an unrelated semantic graph.
            if (distance(source["pose"], {"x": 1., "y": -2., "z": 0.}) > .03 or
                    distance(goal["pose"], {"x": 4.5, "y": -2., "z": .15}) > .03 or
                    set(segment["required_capabilities"]) != {"navigate", "stairs"}):
                raise ValueError("route is outside the certified physical stair scene")
        elif not value.get("inspection") or distance(self.controller.pose, goal["pose"]) > goal["arrival_radius_m"]:
            raise ValueError("inspection navigation requires arrival via the typed stair route")
        if destination != "upper_inspection":
            raise ValueError("unsupported physical scene destination")
        self.seen.add(command_id)
        self.command_id, self.state = command_id, "running"
        self.detail, self.progress = "authorized joint-driven physical traversal", 0
        self.goal, self.speed = goal, min(speed, .3)
        self.inspection = bool(value.get("inspection", False))
        self.deadline = now + remaining / 1000
        self.expires_unix_ms = int(value["expires_unix_ms"])
        self.initial_distance = distance(self.controller.pose, goal["pose"])
        self.best_distance, self.progress_at = self.initial_distance, now
        self.braking, self.stable_since, self.arrived_at = False, None, None
        self.fault_latched = None
        return self.status()

    def tick(self):
        with self.lock:
            now = self.monotonic()
            # Failures take precedence over geometric arrival, including a lease
            # that expires on the same tick the robot reaches its destination.
            fault = self.fault(now)
            if fault:
                self.stop(fault)
            if self.state == "running":
                pose, target = self.controller.pose, self.goal["pose"]
                error = distance(pose, target)
                if error < self.best_distance - .04:
                    self.best_distance, self.progress_at = error, now
                self.progress = min(98, max(0, int(100 * (1 - error / max(.01, self.initial_distance)))))
                if abs(pose["y"] + 2) > .65 or pose["x"] < .5 or pose["x"] > 5.2:
                    self.stop("physical route corridor exceeded")
                elif now - self.progress_at > 6.0 and not self.braking:
                    self.stop("physical traversal made no progress")
                elif error < min(.13, self.goal["arrival_radius_m"] * .6):
                    self.controller.brake()
                    self.braking = True
                elif not self.braking:
                    dx, dy = target["x"] - pose["x"], target["y"] - pose["y"]
                    # Feedback commands are expressed in the learned policy's
                    # body frame. Joint torques alone move the free base.
                    yaw = pose["yaw"]
                    vx = max(0.0, min(self.speed, .9 * dx))
                    vy = max(-.12, min(.12, 1.2 * dy))
                    self.controller.set_velocity(vx * math.cos(yaw) + vy * math.sin(yaw),
                                                 -vx * math.sin(yaw) + vy * math.cos(yaw),
                                                 max(-.3, min(.3, -1.5 * yaw)))
                if self.braking:
                    if (error <= self.goal["arrival_radius_m"] and self.controller.speed < .045 and self.supported() and
                            set(self.controller.metrics.get("contact_steps", [])) >= {"step0", "step1", "step2"}):
                        self.stable_since = now if self.stable_since is None else self.stable_since
                        if now - self.stable_since >= .5:
                            self.state, self.progress = "succeeded", 100
                            self.detail = "physical arrival verified; stationary support brake applied"
                            self.arrived_at = now
                    else:
                        self.stable_since = None
                        if error > self.goal["arrival_radius_m"]:
                            self.stop("braking drift exceeded physical arrival region")
            self.controller.step()
            self.pose_at = self.monotonic()
            if self.controller.fallen:
                self.stop("physical stability/contact fault", invalidate_success=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--map", required=True)
    parser.add_argument("--assets", required=True)
    args = parser.parse_args()
    # Import after argument validation; dependency-free gate tests can import us.
    from controller import Controller
    path = Path(args.socket).absolute()
    if len(str(path).encode()) >= 104:
        raise SystemExit("Unix socket path is too long")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.parent.stat().st_mode & 0o077:
        raise SystemExit("gateway run directory must be private (0700)")
    controller = Controller(Path(args.assets))
    # EGL context/shader initialization can take longer than a lease tick. Do
    # it before accepting commands, while no running goal can be interrupted.
    warmup = path.parent / ".camera-warmup.ppm"
    controller.render_ppm(warmup)
    warmup.unlink()
    gateway = Gateway(controller, json.loads(Path(args.map).read_text()), path.parent)
    ending = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: ending.set())

    def physics():
        next_step = time.monotonic()
        try:
            while not ending.is_set():
                now = time.monotonic()
                if now - next_step > .1 and gateway.state == "running":
                    gateway.fault_latched = "physics scheduling watchdog"
                gateway.tick()
                next_step = max(next_step + .02, time.monotonic())
                ending.wait(max(0, next_step - time.monotonic()))
        except Exception as error:
            with gateway.lock:
                gateway.stop("physics exception: " + str(error))
            ending.set()

    def watchdog():
        while not ending.wait(.02):
            gateway.watchdog()

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))  # Never delete an existing socket owned by a peer.
    os.chmod(path, 0o600)
    listener.listen(8)
    listener.settimeout(.1)
    threads = [threading.Thread(target=physics, daemon=True), threading.Thread(target=watchdog, daemon=True)]
    for thread in threads:
        thread.start()
    print(json.dumps({"socket": str(path), "map_digest": gateway.digest, "engine": "mujoco-separate-world"}), flush=True)
    try:
        while not ending.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(.1)
                try:
                    raw = bytearray()
                    while b"\n" not in raw and len(raw) < 32768:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        raw.extend(chunk)
                    if b"\n" not in raw or len(raw) >= 32768:
                        raise ValueError("bounded newline-terminated JSON request required")
                    value = json.loads(raw.split(b"\n", 1)[0])
                    result = gateway.request(value)
                except (ValueError, OSError) as error:
                    result = gateway.status(False, str(error))
                try:
                    connection.sendall(json.dumps(result, allow_nan=False).encode() + b"\n")
                except OSError:
                    pass
    finally:
        ending.set()
        for thread in threads:
            thread.join(timeout=1)
        gateway.stop("gateway shutdown")
        controller.close()
        listener.close()
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
