#!/usr/bin/env python3
"""Reproducible physical stair/stop regression, with a controlled test clock.

This advances real MuJoCo joint dynamics faster than wall time. Production
gateway.py uses monotonic wall time and a separately checked socket watchdog.
No root pose is changed after Controller's initial scene reset.
"""
import argparse
import json
import math
from pathlib import Path
import tempfile

from controller import Controller
from gateway import Gateway, endpoint, map_digest


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
    args.output.write_text(json.dumps({"engine": "MuJoCo", "test_clock": "controlled 20ms; production is wall-clock paced",
                                       "map_digest": map_digest(semantic_map), "runs": results}, indent=2))


if __name__ == "__main__":
    main()
