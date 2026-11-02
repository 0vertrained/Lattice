#!/usr/bin/env python3
"""Exercise the production wall-clock Unix gateway with real MuJoCo physics."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import time

from gateway import endpoint, map_digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=("arrival", "lease"), default="arrival")
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output.chmod(0o700)
    socket_path = args.output / "gateway.sock"
    semantic_map = json.loads(args.map.read_text())
    places = {p["id"]: p for p in semantic_map["places"]}
    segment = next(s for s in semantic_map["segments"] if s["id"] == "stairs_to_upper")

    def request(value):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(socket_path))
            connection.sendall(json.dumps(value).encode() + b"\n")
            raw = bytearray()
            while not raw.endswith(b"\n"):
                chunk = connection.recv(65536)
                if not chunk:
                    raise RuntimeError("gateway disconnected")
                raw.extend(chunk)
            return json.loads(raw)

    with (args.output / "gateway.log").open("w") as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("gateway.py")),
                                    "--socket", str(socket_path), "--map", str(args.map),
                                    "--assets", str(args.assets)], stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("gateway exited: " + (args.output / "gateway.log").read_text())
                if socket_path.exists():
                    state = request({"op": "status"})
                    if state["ready"]:
                        break
                time.sleep(.05)
            else:
                raise RuntimeError("physics not ready")
            request({"op": "lease"})
            command = {"op": "traverse_route", "command_id": "physical-socket-route", "destination": segment["to"],
                       "max_speed_mps": .3, "ttl_ms": 30000, "expires_unix_ms": int(time.time() * 1000) + 30000,
                       "inspection": False, "traversal": {
                           "map_id": semantic_map["id"], "map_revision": semantic_map["revision"],
                           "map_digest": map_digest(semantic_map), "segment_id": segment["id"],
                           "from": endpoint(places[segment["from"]]), "to": endpoint(places[segment["to"]]),
                           "required_capabilities": segment["required_capabilities"], "max_speed_mps": segment["max_speed_mps"]}}
            state = request(command)
            assert state["ok"], state
            trace = []
            drop = False
            deadline = time.monotonic() + 35
            while state["state"] == "running" and time.monotonic() < deadline:
                if args.mode == "lease" and state["pose"]["x"] >= 2.3:
                    drop = True
                state = request({"op": "status" if drop else "lease"})
                trace.append(state)
                time.sleep(.1)
            if args.mode == "lease":
                assert state["state"] == "failed" and "connection watchdog" in state["detail"], state
                stopped = state["pose"]
                time.sleep(2)
                state = request({"op": "status"})
                drift = ((state["pose"]["x"] - stopped["x"]) ** 2 + (state["pose"]["y"] - stopped["y"]) ** 2) ** .5
                assert drift < .1 and not state["physics"]["fallen"], (state, drift)
                result = {"mode": args.mode, "post_stop_drift_m": drift, "final": state, "trace": trace}
            else:
                assert state["state"] == "succeeded", state
                assert state["physics"]["contact_steps"] == ["step0", "step1", "step2"], state
                inspection = command | {"op": "navigate", "command_id": "physical-socket-inspection", "inspection": True,
                                        "ttl_ms": 10000, "expires_unix_ms": int(time.time() * 1000) + 10000}
                inspection.pop("traversal")
                request({"op": "lease"})
                state = request(inspection)
                assert state["ok"], state
                deadline = time.monotonic() + 8
                while state["state"] == "running" and time.monotonic() < deadline:
                    state = request({"op": "lease"})
                    time.sleep(.1)
                assert state["state"] == "succeeded", state
                assert not request({"op": "capture", "command_id": "wrong-id"})["ok"]
                capture = request({"op": "capture", "command_id": inspection["command_id"]})
                assert capture["ok"], capture
                image = (args.output / capture["capture_file"]).read_bytes()
                assert image.startswith(b"P6\n320 240\n255\n") and len(image) == 230415
                result = {"mode": args.mode, "final": state, "capture": capture, "trace": trace}
            (args.output / "proof.json").write_text(json.dumps(result, indent=2))
            print(json.dumps({k: v for k, v in result.items() if k != "trace"}), flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
