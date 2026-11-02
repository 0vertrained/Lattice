#!/usr/bin/env python3
"""Reproducible physical stair/stop regression, with a controlled test clock.

This advances real MuJoCo joint dynamics faster than wall time. Production
gateway.py uses monotonic wall time and a separately checked socket watchdog.
No root pose is changed after Controller's initial scene reset.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile

from controller import Controller
from gateway import Gateway, endpoint, map_digest


def summary(report, proof_bytes):
    """Compact measured results; failures are expected refusal cases, not arrivals."""
    return {"schema": "lattice.quadruped-evaluation.v1", "engine": report["engine"],
            "test_clock": report["test_clock"], "map_digest": report["map_digest"],
            "raw_proof_sha256": hashlib.sha256(proof_bytes).hexdigest(),
            "scope": "Six bounded simulation cases; separate from the authenticated full mission recording.",
            "runs": [{"initial_yaw_rad": run["initial_yaw"], "friction": run["friction"],
                      "case": run["interrupt"] or "arrival",
                      "expected_state": "failed" if run["interrupt"] else "succeeded",
                      "observed_state": run["state"], "detail": run["detail"],
                      "final_pose": run["pose"], "post_stop_drift_m": run["post_stop_drift_m"],
                      "contact_steps": run["physics"]["contact_steps"],
                      "max_tilt_rad": run["physics"]["max_tilt"],
                      "max_motor_torque_nm": run["physics"]["max_motor_torque"],
                      "torso_contact": run["physics"]["torso_contact"],
                      "trace_sample_count": len(run["trace"])} for run in report["runs"]]}


class Clock:
    def __init__(self):
        self.value = 1000.

    def __call__(self):
        return self.value


def run(assets, semantic_map, yaw=0., friction=.8, interrupt=None):
    clock = Clock()
    controller = Controller(assets, initial_yaw=yaw, friction=friction, riser_height=.25 if interrupt == "unsupported" else .05)
    with tempfile.TemporaryDirectory() as directory:
        gateway = Gateway(controller, semantic_map, directory, clock, clock)

        def step(lease=True):
            clock.value += .02
            if lease:
                gateway.request({"op": "lease"})
            gateway.tick()

        for _ in range(100):
            step()
        segment = next(s for s in semantic_map["segments"] if s["id"] == "stairs_to_upper")
        command = {"op": "traverse_route", "command_id": "physical-proof", "destination": segment["to"],
                   "max_speed_mps": .3, "ttl_ms": 30000, "expires_unix_ms": int(clock() * 1000) + 30000,
                   "inspection": False, "traversal": {
                       "map_id": semantic_map["id"], "map_revision": semantic_map["revision"],
                       "map_digest": gateway.digest, "segment_id": segment["id"],
                       "from": endpoint(gateway.places[segment["from"]]), "to": endpoint(gateway.places[segment["to"]]),
                       "required_capabilities": segment["required_capabilities"], "max_speed_mps": segment["max_speed_mps"]}}
        accepted = gateway.request(command)
        if not accepted["ok"]:
            raise AssertionError(accepted)
        trace, stop_position, drift, dropout = [], None, 0., False
        for tick in range(1700):
            if interrupt and controller.pose["x"] >= 2.3 and not dropout:
                dropout = True
                if interrupt == "stop":
                    gateway.request({"op": "stop"})
            step(not (dropout and interrupt == "lease"))
            if gateway.state in ("succeeded", "failed") and stop_position is None:
                stop_position = dict(controller.pose)
                stopped_tick = tick
            if stop_position:
                drift = max(drift, math.hypot(controller.pose["x"] - stop_position["x"],
                                             controller.pose["y"] - stop_position["y"]))
            if tick % 5 == 0:
                trace.append({"t": clock() - 1000, "state": gateway.state, "pose": controller.pose,
                              "physics": controller.metrics})
            if stop_position and tick - stopped_tick > 250:
                break
        result = {"initial_yaw": yaw, "friction": friction, "interrupt": interrupt,
                  "state": gateway.state, "detail": gateway.detail, "pose": controller.pose,
                  "physics": controller.metrics, "post_stop_drift_m": drift, "trace": trace}
        if interrupt:
            assert gateway.state == "failed", result
        else:
            assert gateway.state == "succeeded", result
            assert set(controller.metrics["contact_steps"]) == {"step0", "step1", "step2"}, result
            assert gateway.supported() and controller.speed < .045, result
        if interrupt == "unsupported":
            assert controller.fallen and controller.metrics["torso_contact"], result
        else:
            assert not controller.fallen and drift < .1, result
        assert controller.metrics["max_motor_torque"] <= 33.5, result
        controller.close()
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--assets", required=True, type=Path)
    p.add_argument("--map", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--summary-output", type=Path, help="optional compact measured evaluation report")
    args = p.parse_args()
    semantic_map = json.loads(args.map.read_text())
    results = []
    for yaw, friction in [(0., .8), (-.04, .7), (.04, .9)]:
        result = run(args.assets, semantic_map, yaw, friction)
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k != "trace"}), flush=True)
    for mode in ("lease", "stop", "unsupported"):
        result = run(args.assets, semantic_map, interrupt=mode)
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k != "trace"}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {"engine": "MuJoCo", "test_clock": "controlled 20ms; production is wall-clock paced",
              "map_digest": map_digest(semantic_map), "runs": results}
    proof_bytes = json.dumps(report, indent=2).encode()
    args.output.write_bytes(proof_bytes)
    if args.summary_output:
        args.summary_output.parent.mkdir(parents=True, exist_ok=True)
        args.summary_output.write_text(json.dumps(summary(report, proof_bytes), indent=2) + "\n")


if __name__ == "__main__":
    main()
