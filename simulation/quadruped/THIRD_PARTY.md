# Quadruped controller provenance

The robot is a Unitree Go1 model in **MuJoCo 3.3.7**, driven by the existing
**Walk These Ways** learned policy using **NumPy 2.2.6** inference on CPU. Lattice
does not claim to have trained this locomotion policy. Lattice contributes the
policy adapter, bounded stair fixture, semantic-frame transform, physical
braking mode, authenticated orchestration and measured arrival checks.

`assets.py` downloads the following immutable revisions and verifies the exact
byte count and SHA-256 of every file before use. Its `FILES` constant is the
complete asset manifest; the installed `provenance.json` records those same
URLs and hashes. Model data and weights are downloaded into ignored `target/`
storage, not committed to the repository.

| Component | Pinned source | License |
| --- | --- | --- |
| Go1 pretrained actor/adaptation weights | [Walk These Ways, `0e7236bdc81ce855cbe3d70345a7899452bdeb1c`](https://github.com/Improbable-AI/walk-these-ways/tree/0e7236bdc81ce855cbe3d70345a7899452bdeb1c), `runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/ac_weights_last.pt` | MIT, MIT Improbable AI Lab |
| Go1 MJCF and five STL meshes | [MuJoCo Menagerie, `b0655057a9df2abe39ea7fc989914ba6f248301c`](https://github.com/google-deepmind/mujoco_menagerie/tree/b0655057a9df2abe39ea7fc989914ba6f248301c/unitree_go1) | BSD 3-Clause, Unitree Robotics |
| Physics engine | [MuJoCo 3.3.7](https://github.com/google-deepmind/mujoco/releases/tag/3.3.7) | Apache 2.0 |
| Numerical inference | [NumPy 2.2.6](https://github.com/numpy/numpy/releases/tag/v2.2.6) | BSD 3-Clause and bundled third-party notices |

The deployment observation/joint conventions follow the pinned upstream
`go1_gym_deploy/envs/lcm_agent.py`, `go1_gym_deploy/envs/history_wrapper.py`,
`go1_gym_learn/ppo_cse/actor_critic.py`, and the checkpoint's accompanying training
configuration. We use only actor and adaptation tensors, with the unchanged
ELU network topology. No upstream training framework, CUDA, Isaac Gym or Torch
runtime is needed. The installer accepts only the pinned checkpoint hash,
whitelists three tensor-deserialization globals, validates storage bounds and
tensor shapes, and exports NPZ; runtime loads NPZ with `allow_pickle=False`.

- Original checkpoint SHA-256: `d1542b0b8c7b767753a286f1cbabe5b4dc86e67611fb95844e870b3c61f8869e`.
- Converted policy SHA-256: `97d31a2b22c9cad6e4d7af04ed69069f9e07820cfb41d2e742f5a725d86858e4`.
- Downloaded assets total approximately 22.6 MB; converted runtime policy is
  6.8 MB. Meshes are the original pinned model assets.

The policy runs at 50 Hz with four MuJoCo 5 ms physics steps per action. Twelve
motor torques, limited to ±33.5 Nm, drive all movement. The free base is assigned
only during initialization. Zero velocity under the learned gait is **not** a
stop guarantee: the physical brake uses fixed standing joint targets with
Kp=30, Kd=1.5 while physics continues. The gateway owns watchdogs, corridor
feedback, no-progress limits and success authorization.

This fixture represents a separate physics engine from the Gazebo rovers.
Its explicit semantic transform is `x=local_x+1`, `y=local_y-2`,
`z=measured_base_z-0.262`. The last value subtracts a fixed nominal standing
height; it never snaps the pose to terrain. Raw measured base height remains in
telemetry. The scene has three real 5 cm risers starting at local x=1, 1.4 and
1.8 m. Validation on these bounded stairs does not establish general terrain
or physical-hardware safety, and a blocked stair is a failed mission rather
than a timed success.

## Walk These Ways license

MIT License

Copyright (c) 2022 MIT Improbable AI Lab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Upstream also references `licenses/legged_gym` and `licenses/rsl_rl` for files
whose headers identify those additional licenses. Those training-framework
files are not copied or imported by this adapter.

## Unitree Go1 model license

BSD 3-Clause License

Copyright (c) 2016-2022 HangZhou YuShu TECHNOLOGY CO.,LTD. ("Unitree Robotics")
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of the copyright holder nor the names of its contributors
  may be used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
