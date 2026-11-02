"""NumPy inference for the pinned Walk These Ways Go1 policy.

Only tensor data from the install-time conversion is loaded at runtime. The
history, joint ordering, gait clock and observation scales match its hardware
deployment configuration; no trained weights are changed here.
"""
from pathlib import Path
import hashlib

import numpy as np

POLICY_SHA256 = "97d31a2b22c9cad6e4d7af04ed69069f9e07820cfb41d2e742f5a725d86858e4"
JOINT_NAMES = tuple(f"{leg}_{part}_joint" for leg in ("FL", "FR", "RL", "RR")
                    for part in ("hip", "thigh", "calf"))
DEFAULT_ANGLES = np.array([.1, .8, -1.5, -.1, .8, -1.5,
                           .1, 1., -1.5, -.1, 1., -1.5])
SHAPES = {}
for _prefix, _dimensions in (("adaptation_module", (2100, 256, 128, 2)),
                              ("actor_body", (2102, 512, 256, 128, 12))):
    for _index, (_inputs, _outputs) in enumerate(zip(_dimensions, _dimensions[1:])):
        SHAPES[f"{_prefix}.{_index * 2}.weight"] = (_outputs, _inputs)
        SHAPES[f"{_prefix}.{_index * 2}.bias"] = (_outputs,)


class Policy:
    def __init__(self, path):
        path = Path(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != POLICY_SHA256:
            raise ValueError("quadruped policy checksum mismatch; rerun assets.py")
        with np.load(path, allow_pickle=False) as archive:
            if set(archive.files) != set(SHAPES):
                raise ValueError("unexpected policy tensors")
            self.weights = {name: archive[name] for name in SHAPES}
        for name, shape in SHAPES.items():
            value = self.weights[name]
            if value.shape != shape or value.dtype != np.float32 or not np.isfinite(value).all():
                raise ValueError(f"invalid policy tensor: {name}")
        self.reset_history()

    def reset_history(self):
        self.history = np.zeros(2100, dtype=np.float32)
        self.actions = np.zeros(12)
        self.previous_actions = np.zeros(12)
        self.phase = 0.
        self.clock = np.zeros(4)

    def _network(self, prefix, value, last):
        for index in range(0, last + 1, 2):
            value = self.weights[f"{prefix}.{index}.weight"] @ value + self.weights[f"{prefix}.{index}.bias"]
            if index != last:
                value = np.where(value >= 0, value, np.expm1(np.minimum(value, 0)))
        return value

    def targets(self, gravity, joint_positions, joint_velocities, velocity):
        command = np.array([*velocity, 0, 3, .5, 0, 0, .5, .12, 0, 0, .25, .4, 0])
        scale = np.array([2, 2, .25, 2, 1, 1, 1, 1, 1, .15, .3, .3, 1, 1, 1])
        observation = np.concatenate((gravity, command * scale,
            joint_positions - DEFAULT_ANGLES, joint_velocities * .05,
            self.actions, self.previous_actions, self.clock)).astype(np.float32)
        self.history[:-70] = self.history[70:]
        self.history[-70:] = observation
        latent = self._network("adaptation_module", self.history, 4)
        action = np.clip(self._network("actor_body", np.concatenate((self.history, latent)), 6), -10, 10)
        if not np.isfinite(action).all():
            raise ValueError("non-finite quadruped policy action")
        self.previous_actions = self.actions.copy()
        self.actions = action
        target = action * .25
        target[[0, 3, 6, 9]] *= .5
        self.phase = (self.phase + .02 * 3) % 1
        self.clock = np.sin(2 * np.pi * (self.phase + np.array([.5, 0, 0, .5])))
        return target + DEFAULT_ANGLES
