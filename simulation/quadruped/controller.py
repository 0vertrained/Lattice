"""Joint-actuated Go1 in a bounded, separate MuJoCo stair scene.

The free base is initialized once. Every subsequent movement, including brake
and standing, results from bounded motor torques and MuJoCo contact physics.
This is not Gazebo's physics world: the explicit semantic frame transform is
translation (1, -2, -.262) from the measured MuJoCo base position.
"""
from __future__ import annotations

import math
import os
from pathlib import Path
import xml.etree.ElementTree as ET

os.environ.setdefault("MUJOCO_GL", "egl")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import mujoco
import numpy as np

try:
    from .assets import verify
    from .policy import DEFAULT_ANGLES, JOINT_NAMES, Policy
except ImportError:
    from assets import verify
    from policy import DEFAULT_ANGLES, JOINT_NAMES, Policy


class Controller:
    CONTROL_DT = .02
    PHYSICS_DT = .005
    NOMINAL_BASE_HEIGHT = .262

    def __init__(self, asset_dir, *, initial_yaw=0., friction=.8, riser_height=.05,
                 global_offset=(1., -2., 0.)):
        self.asset_dir = Path(asset_dir).resolve()
        verify(self.asset_dir)
        if not (math.isfinite(initial_yaw) and .2 <= friction <= 2 and 0 < riser_height <= .3):
            raise ValueError("invalid initial physical conditions")
        self.offset = np.array(global_offset, dtype=float)
        if self.offset.shape != (3,) or not np.isfinite(self.offset).all():
            raise ValueError("invalid frame translation")
        self.riser_height = riser_height
        self.policy = Policy(self.asset_dir / "policy.npz")
        self.model = self._model(friction)
        self.data = mujoco.MjData(self.model)
        self.joint_positions = np.array([self.model.jnt_qposadr[self._id(mujoco.mjtObj.mjOBJ_JOINT, name)] for name in JOINT_NAMES])
        self.joint_velocities = np.array([self.model.jnt_dofadr[self._id(mujoco.mjtObj.mjOBJ_JOINT, name)] for name in JOINT_NAMES])
        self.actuators = np.array([self._id(mujoco.mjtObj.mjOBJ_ACTUATOR, name[:-6]) for name in JOINT_NAMES])
        self.trunk = self._id(mujoco.mjtObj.mjOBJ_BODY, "trunk")
        # The only writes to free-base state in this controller.
        self.data.qpos[:7] = [0, 0, .35, math.cos(initial_yaw / 2), 0, 0, math.sin(initial_yaw / 2)]
        self.data.qpos[self.joint_positions] = DEFAULT_ANGLES
        mujoco.mj_forward(self.model, self.data)
        self.command = np.zeros(3)
        self.mode = "stance"
        self.contact_steps = set()
        self.max_motor_torque = 0.
        self.max_tilt = 0.
        self._fallen = False
        self._airborne_since = None
        self._renderer = None
        self.torso_contact = False

    def _id(self, kind, name):
        result = mujoco.mj_name2id(self.model, kind, name)
        if result < 0:
            raise ValueError(f"missing model object: {name}")
        return result

    def _model(self, friction):
        root = ET.parse(self.asset_dir / "unitree_go1/go1.xml").getroot()
        root.find("compiler").set("meshdir", str(self.asset_dir / "unitree_go1/assets"))
        root.find("option").set("timestep", str(self.PHYSICS_DT))
        for joint in root.findall(".//default//joint"):
            joint.set("damping", "0")
            joint.set("frictionloss", "0")
        for geom in root.findall(".//geom"):
            if geom.get("condim") == "6":
                geom.set("friction", f"{friction} .02 .01")
        root.remove(root.find("keyframe"))
        actuator = root.find("actuator")
        for item in list(actuator):
            actuator.remove(item)
            ET.SubElement(actuator, "motor", name=item.get("name"),
                          joint=item.get("joint"), ctrlrange="-33.5 33.5")
        world = root.find("worldbody")
        ET.SubElement(world, "geom", name="floor", type="plane", size="20 20 .05",
                      friction=f"{friction} .02 .01", rgba=".23 .25 .28 1")
        for index in range(3):
            half_height = (index + 1) * self.riser_height / 2
            ET.SubElement(world, "geom", name=f"step{index}", type="box",
                          pos=f"{3 + index * .4} 0 {half_height}", size=f"2 1 {half_height}",
                          rgba=".48 .55 .58 1", friction=f"{friction} .02 .01")
        trunk = world.find("body[@name='trunk']")
        ET.SubElement(trunk, "camera", name="front", pos=".30 0 .13",
                      xyaxes="0 -1 0 0 0 1", fovy="65")
        ET.SubElement(world, "camera", name="overview", pos="2 -4 2.4",
                      xyaxes="1 0 0 0 .45 .89")
        # Real scene geometry: red octagonal inspection marker on the landing.
        vertices = []
        for depth in (-.008, .008):
            for index in range(8):
                angle = math.pi / 8 + index * math.pi / 4
                vertices.extend((depth, .22 * math.cos(angle), .22 * math.sin(angle)))
        ET.SubElement(root.find("asset"), "mesh", name="inspection_octagon",
                      vertex=" ".join(map(str, vertices)))
        marker_z = 3 * self.riser_height + .60
        ET.SubElement(world, "geom", name="inspection_marker", type="mesh",
                      mesh="inspection_octagon", pos=f"4.6 0 {marker_z}",
                      rgba=".85 .025 .02 1", contype="0", conaffinity="0")
        ET.SubElement(world, "geom", name="marker_post", type="box", pos=f"4.62 0 {marker_z / 2}",
                      size=f".018 .018 {marker_z / 2}", rgba=".6 .6 .6 1", contype="0", conaffinity="0")
        return mujoco.MjModel.from_xml_string(ET.tostring(root).decode())

    def set_velocity(self, vx, vy, yaw_rate):
        command = np.array([vx, vy, yaw_rate], dtype=float)
        if not np.isfinite(command).all() or np.any(np.abs(command) > [.4, .25, .5]):
            raise ValueError("quadruped velocity outside reviewed bounds")
        if self.fallen:
            self.brake()
            raise ValueError("quadruped physical fault is latched")
        if not np.any(command):
            self.brake()
            return
        if self.mode != "policy":
            self.policy.reset_history()
        self.command = command
        self.mode = "policy"

    def brake(self):
        self.command = np.zeros(3)
        self.mode = "stance"

    def step(self, dt=.02):
        if not math.isclose(dt, self.CONTROL_DT, abs_tol=1e-9):
            raise ValueError("policy requires 20 ms control steps")
        target = DEFAULT_ANGLES
        if self.mode == "policy" and not self.fallen:
            gravity = self.data.xmat[self.trunk].reshape(3, 3).T @ np.array([0, 0, -1])
            try:
                target = self.policy.targets(gravity, self.data.qpos[self.joint_positions],
                    self.data.qvel[self.joint_velocities], self.command)
            except ValueError:
                self._fallen = True
                self.brake()
                raise
        kp, kd = (20., .5) if self.mode == "policy" else (30., 1.5)
        for _ in range(4):
            self.data.ctrl[self.actuators] = np.clip(kp * (target - self.data.qpos[self.joint_positions])
                - kd * self.data.qvel[self.joint_velocities], -33.5, 33.5)
            self.max_motor_torque = max(self.max_motor_torque, float(np.max(np.abs(self.data.ctrl))))
            mujoco.mj_step(self.model, self.data)
            for contact in self.data.contact:
                names = {mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_GEOM, int(geom)) for geom in contact.geom}
                if names & {"FL", "FR", "RL", "RR"}:
                    self.contact_steps.update(name for name in names if name and name.startswith("step"))
                if self.data.time > 1. and ("floor" in names or names & {"step0", "step1", "step2"}):
                    if any(self.model.geom_bodyid[int(geom)] == self.trunk for geom in contact.geom):
                        self.torso_contact = True
        self.max_tilt = max(self.max_tilt, self.tilt)
        x, y, z = self.data.qpos[:3]
        ground = self.riser_height * sum(x >= threshold for threshold in (1., 1.4, 1.8)) if abs(y) < 1 else 0
        if self.data.ncon == 0:
            if self._airborne_since is None:
                self._airborne_since = self.data.time
        else:
            self._airborne_since = None
        if (not np.isfinite(self.data.qpos).all() or not np.isfinite(self.data.qvel).all()
                or self.torso_contact or self.tilt > 1.2 or z < ground + .11
                or abs(y) > 1.2 or x < -.5 or x > 5.0
                or self._airborne_since is not None and self.data.time - self._airborne_since > .7):
            self._fallen = True
            self.brake()
        return self.metrics

    @property
    def tilt(self):
        return float(np.arccos(np.clip(self.data.xmat[self.trunk].reshape(3, 3)[2, 2], -1, 1)))

    @property
    def fallen(self):
        return self._fallen

    @property
    def speed(self):
        return float(np.linalg.norm(self.data.qvel[:2]))

    @property
    def pose(self):
        position = self.data.qpos[:3] + self.offset
        rotation = self.data.xmat[self.trunk].reshape(3, 3)
        return {"x": float(position[0]), "y": float(position[1]),
                "z": float(position[2] - self.NOMINAL_BASE_HEIGHT),
                "yaw": float(math.atan2(rotation[1, 0], rotation[0, 0]))}

    @property
    def metrics(self):
        foot_contacts = []
        for index, contact in enumerate(self.data.contact):
            names = [mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_GEOM, int(geom)) for geom in contact.geom]
            feet = set(names) & {"FL", "FR", "RL", "RR"}
            if feet:
                force = np.zeros(6)
                mujoco.mj_contactForce(self.model, self.data, index, force)
                foot_contacts.append({"foot": next(iter(feet)), "surfaces": names,
                                      "normal_force_n": float(force[0])})
        return {"simulation_time": float(self.data.time), "mode": self.mode,
                # Read-only complete generalized state supports faithful visual
                # replay of the measured signed run, including all 12 joints.
                "qpos": self.data.qpos.tolist(), "qvel": self.data.qvel.tolist(),
                "local_position": self.data.qpos[:3].tolist(), "pose": self.pose,
                "base_z": float(self.data.qpos[2]), "nominal_base_height": self.NOMINAL_BASE_HEIGHT,
                "frame_translation": self.offset.tolist(), "quaternion_wxyz": self.data.qpos[3:7].tolist(),
                "velocity": self.data.qvel[:3].tolist(), "command_velocity": self.command.tolist(),
                "tilt": self.tilt, "max_tilt": self.max_tilt, "contacts": int(self.data.ncon),
                "contact_steps": sorted(self.contact_steps), "foot_contacts": foot_contacts,
                "torso_contact": self.torso_contact,
                "joint_motion": float(np.linalg.norm(self.data.qvel[self.joint_velocities])),
                "motor_torques": self.data.ctrl[self.actuators].tolist(),
                "max_motor_torque": self.max_motor_torque, "fallen": self.fallen}

    def snapshot(self):
        return self.metrics

    def render_ppm(self, path, camera="front"):
        if self._renderer is None:
            self._renderer = mujoco.Renderer(self.model, height=240, width=320)
        self._renderer.update_scene(self.data, camera=camera)
        pixels = self._renderer.render()
        if pixels.shape != (240, 320, 3) or pixels.dtype != np.uint8:
            raise ValueError("unexpected camera output")
        path = Path(path)
        path.write_bytes(b"P6\n320 240\n255\n" + pixels.tobytes())
        return path

    def close(self):
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
