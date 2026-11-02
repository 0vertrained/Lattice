"""Safety-contract tests use a deliberately inert body; stair proof is separate."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from gateway import Gateway, endpoint, map_digest


class Clock:
    value = 10.0

    def __call__(self):
        return self.value


class Body:
    pose = {"x": 1., "y": -2., "z": 0., "yaw": 0.}
    fallen = False
    speed = 0.
    metrics = {"foot_contacts": [{"foot": name, "normal_force_n": 20} for name in ("FL", "FR", "RL", "RR")],
               "tilt": 0., "velocity": [0., 0., 0.], "contact_steps": ["step0", "step1", "step2"]}
    stepped = 0
    moving = False

    def brake(self):
        self.moving = False

    def set_velocity(self, *_):
        self.moving = True

    def step(self):
        self.stepped += 1

    def render_ppm(self, _):
        raise AssertionError("unit test must not substitute camera evidence")


def fixture():
    return {"id": "stair_lab", "revision": 1, "frame_id": "map", "places": [
        {"id": "transfer", "label": "Transfer", "pose": {"x": 1., "y": -2., "z": 0.},
         "arrival_radius_m": .4, "transfer_allowed": True},
        {"id": "upper_inspection", "label": "Upper inspection", "pose": {"x": 4.5, "y": -2., "z": .15},
         "arrival_radius_m": .25, "transfer_allowed": False}],
        "segments": [{"id": "stairs", "from": "transfer", "to": "upper_inspection",
                      "required_capabilities": ["navigate", "stairs"], "max_speed_mps": .3, "enabled": True}]}


class GatewaySafetyTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.body = Clock(), Body()
        self.body.pose = dict(Body.pose)
        self.body.fallen = False
        self.tmp = tempfile.TemporaryDirectory()
        self.map = fixture()
        self.g = Gateway(self.body, self.map, self.tmp.name, self.clock, self.clock)
        self.clock.value += 2
        self.g.tick()
        self.g.request({"op": "lease"})

    def tearDown(self):
        self.tmp.cleanup()

    def command(self):
        return {"op": "traverse_route", "command_id": "command-one", "destination": "upper_inspection",
                "max_speed_mps": .3, "ttl_ms": 30000, "expires_unix_ms": 42000, "inspection": False,
                "traversal": {"map_id": self.map["id"], "map_revision": 1, "map_digest": map_digest(self.map),
                              "segment_id": "stairs", "from": endpoint(self.map["places"][0]), "to": endpoint(self.map["places"][1]),
                              "required_capabilities": ["navigate", "stairs"], "max_speed_mps": .3}}

    def advance(self, seconds, lease=True):
        for _ in range(round(seconds / .02)):
            self.clock.value += .02
            if lease:
                self.g.request({"op": "lease"})
            self.g.tick()

    def test_motion_requires_live_lease_and_current_source(self):
        self.g.lease_at = -100
        self.assertFalse(self.g.request(self.command())["ok"])
        self.g.request({"op": "lease"})
        self.body.pose["x"] = 2.
        self.assertFalse(self.g.request(self.command())["ok"])
        self.assertFalse(self.body.moving)

    def test_snapshot_changes_fail_before_actuation(self):
        for key, value in [("map_digest", "0" * 64), ("map_revision", 2), ("required_capabilities", ["navigate"]),
                           ("max_speed_mps", .4), ("segment_id", "not_stairs")]:
            command = self.command()
            command["traversal"][key] = value
            self.assertFalse(self.g.request(command)["ok"], key)
        command = self.command()
        command["traversal"]["to"] = copy.deepcopy(command["traversal"]["to"])
        command["traversal"]["to"]["pose"]["z"] = 0.
        self.assertFalse(self.g.request(command)["ok"])
        self.assertFalse(self.body.moving)

    def test_rust_canonical_fixture_and_f32_snapshot_are_accepted(self):
        routes = Path(__file__).parents[1] / "routes"
        semantic_map = json.loads((routes / "warehouse-stairs.json").read_text())
        fixture = json.loads((routes / "warehouse-stairs.snapshots.json").read_text())
        self.assertEqual(map_digest(semantic_map), fixture["map_digest"])
        gateway = Gateway(self.body, semantic_map, self.tmp.name, self.clock, self.clock)
        self.clock.value += 2
        gateway.tick()
        gateway.request({"op": "lease"})
        traversal = next(t for t in fixture["traversals"] if t["segment_id"] == "stairs_to_upper")
        command = self.command() | {"traversal": traversal, "max_speed_mps": traversal["max_speed_mps"]}
        self.assertTrue(gateway.request(command)["ok"])

    def test_lease_loss_brakes_while_physics_continues(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.g.tick()
        self.assertTrue(self.body.moving)
        steps = self.body.stepped
        self.advance(1.6, lease=False)
        self.assertEqual(self.g.state, "failed")
        self.assertIn("watchdog", self.g.detail)
        self.assertFalse(self.body.moving)
        self.assertGreater(self.body.stepped, steps)

    def test_signed_deadline_wins_over_arrival_and_new_lease(self):
        command = self.command()
        command["ttl_ms"] = 300
        self.assertTrue(self.g.request(command)["ok"])
        self.body.pose = self.map["places"][1]["pose"] | {"yaw": 0.}
        self.advance(.32)
        self.assertEqual(self.g.state, "failed")
        self.assertEqual(self.g.detail, "signed command expired")

    def test_no_success_from_elapsed_time_when_physically_blocked(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.advance(6.1)
        self.assertEqual(self.g.state, "failed")
        self.assertIn("no progress", self.g.detail)
        self.assertLess(self.g.progress, 100)

    def test_fall_and_estop_win_over_goal(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.body.pose = self.map["places"][1]["pose"] | {"yaw": 0.}
        self.body.fallen = True
        self.advance(.6)
        self.assertEqual(self.g.state, "failed")
        self.assertFalse(self.g.ready())

    def test_stale_capture_and_bypass_are_rejected(self):
        command = self.command() | {"op": "navigate", "inspection": True}
        self.assertFalse(self.g.request(command)["ok"])
        self.assertFalse(self.g.request({"op": "capture", "command_id": "command-one"})["ok"])

    def test_capture_rechecks_monotonic_deadline_lease_and_arrival(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.body.pose = self.map["places"][1]["pose"] | {"yaw": 0.}
        self.advance(.6)
        self.g.inspection = True
        self.assertTrue(self.g.capture_ready(self.g.command_id))
        self.g.deadline = self.clock.value
        self.assertFalse(self.g.capture_ready(self.g.command_id))
        self.g.deadline += 100
        self.g.lease_at = self.clock.value - 1.6
        self.assertFalse(self.g.capture_ready(self.g.command_id))
        self.g.lease_at = self.clock.value
        self.body.pose["x"] += 1
        self.assertFalse(self.g.capture_ready(self.g.command_id))

    def test_fall_on_completion_physics_tick_invalidates_success(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.body.pose = self.map["places"][1]["pose"] | {"yaw": 0.}
        self.advance(.48)
        self.g.stable_since = self.clock.value - 1
        self.body.step = lambda: setattr(self.body, "fallen", True)
        self.g.tick()
        self.assertEqual(self.g.state, "failed")

    def test_arrival_requires_geometry_brake_and_stable_period(self):
        self.assertTrue(self.g.request(self.command())["ok"])
        self.body.pose = self.map["places"][1]["pose"] | {"yaw": 0.}
        self.body.speed = .2
        self.advance(.6)
        self.assertEqual(self.g.state, "running")
        self.body.speed = 0
        self.advance(.6)
        self.assertEqual(self.g.state, "succeeded")
        self.assertFalse(self.body.moving)
        self.assertEqual(self.g.progress, 100)
        self.assertFalse(self.g.request(self.command())["ok"])


if __name__ == "__main__":
    unittest.main()
