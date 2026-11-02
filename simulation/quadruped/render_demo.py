#!/usr/bin/env python3
"""Render a real Go1 stair run with an external MuJoCo camera.

--trace replays measured qpos/qvel from an actual gateway recording. It never
infers legs from base pose. Without --trace, this records a separate physical
gateway/controller probe, explicitly identified in the provenance manifest.
Rendering changes only the camera and lighting, never the source trajectory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MUJOCO_GL", "egl")

import mujoco
import numpy as np

from assets import MODEL_COMMIT, WTW_COMMIT
from controller import Controller
from gateway import Gateway, endpoint, map_digest
from policy import POLICY_SHA256


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def measured_samples(value):
    """Require one explicit stream; never splice separate simulator runs."""
    if isinstance(value, dict):
        value = value.get("physics")
    if not isinstance(value, list) or len(value) > 100000:
        raise ValueError("one explicit bounded physics[] stream is required")
    return value


def validate_source(raw, semantic_map):
    expected_map = map_digest(semantic_map)
    source_map = raw.get("map_digest") or raw.get("proposal", {}).get("plan", {}).get("map_digest")
    if source_map != expected_map:
        raise ValueError("source recording map digest differs from the reviewed render scene")
    provenance = raw.get("physics_provenance", {})
    if (provenance.get("policy_sha256") != POLICY_SHA256 or provenance.get("model_commit") != MODEL_COMMIT or
            provenance.get("mujoco_version") != mujoco.__version__):
        raise ValueError("source physics/policy/model provenance does not match pinned assets")
    if raw.get("source_kind") == "independent_gateway_controller_probe":
        if raw.get("outcome") != "succeeded":
            raise ValueError("independent probe was not successful")
    elif raw.get("round", {}).get("status") != "completed":
        raise ValueError("source signed mission round was not completed")


def record_probe(assets, semantic_map):
    """Independent test-clock probe; this is not the signed integration mission."""
    class Clock:
        value = 1000.

        def __call__(self):
            return self.value

    clock = Clock()
    controller = Controller(assets)
    samples = []
    with tempfile.TemporaryDirectory() as directory:
        gateway = Gateway(controller, semantic_map, directory, clock, clock)

        def tick():
            clock.value += .02
            gateway.request({"op": "lease", "command_id": "independent-video-probe"})
            gateway.tick()
            samples.append(controller.metrics | {"gateway_state": gateway.state})

        for _ in range(100):
            tick()
        segment = next(s for s in semantic_map["segments"] if s["id"] == "stairs_to_upper")
        request = {"op": "traverse_route", "command_id": "independent-video-probe", "destination": segment["to"],
                   "max_speed_mps": .3, "ttl_ms": 30000, "expires_unix_ms": int(clock() * 1000) + 30000,
                   "inspection": False, "traversal": {
                       "map_id": semantic_map["id"], "map_revision": semantic_map["revision"],
                       "map_digest": gateway.digest, "segment_id": segment["id"],
                       "from": endpoint(gateway.places[segment["from"]]), "to": endpoint(gateway.places[segment["to"]]),
                       "required_capabilities": segment["required_capabilities"], "max_speed_mps": segment["max_speed_mps"]}}
        response = gateway.request(request)
        if not response["ok"]:
            raise ValueError(response["detail"])
        for _ in range(1500):
            tick()
            if gateway.state != "running":
                break
        if gateway.state != "succeeded":
            raise ValueError("physical probe did not arrive: " + gateway.detail)
        for _ in range(250):
            tick()
        if controller.fallen or not gateway.supported():
            raise ValueError("physical probe lost support after arrival")
        controller.close()
    return {"source_kind": "independent_gateway_controller_probe", "clock": "controlled 20ms physics steps",
            "outcome": "succeeded", "map_digest": map_digest(semantic_map), "physics": samples,
            "physics_provenance": {"policy_sha256": POLICY_SHA256, "model_commit": MODEL_COMMIT,
                                   "mujoco_version": mujoco.__version__}}


def select_samples(raw, model):
    samples = measured_samples(raw)
    if not samples:
        raise ValueError("recording has no complete measured qpos/qvel; cannot reconstruct actual joint motion")
    unique = {}
    previous_t = -math.inf
    for sample in samples:
        t = float(sample["simulation_time"])
        qpos, qvel = np.asarray(sample["qpos"]), np.asarray(sample["qvel"])
        if (not math.isfinite(t) or qpos.shape != (model.nq,) or qvel.shape != (model.nv,) or
                not np.isfinite(qpos).all() or not np.isfinite(qvel).all() or
                not math.isclose(float(np.linalg.norm(qpos[3:7])), 1., abs_tol=1e-4)):
            raise ValueError("invalid complete physical state")
        if t < previous_t:
            raise ValueError("source time reset; separate runs must not be merged")
        if t in unique and (unique[t]["qpos"] != sample["qpos"] or unique[t]["qvel"] != sample["qvel"]):
            raise ValueError("conflicting physical states at the same simulator timestamp")
        if sample.get("frame_translation") != [1., -2., 0.] or sample.get("nominal_base_height") != .262:
            raise ValueError("source simulator frame does not match the reviewed render scene")
        unique.setdefault(t, sample)
        previous_t = t
    samples = [unique[t] for t in sorted(unique)]
    walking = [s for s in samples if s.get("mode") == "policy"]
    if not walking:
        raise ValueError("recording contains no actual policy-driven traversal")
    if samples[-1]["simulation_time"] - walking[-1]["simulation_time"] < 4.4:
        raise ValueError("record at least 4.5 seconds of actual support stance after walking ends")
    start = max(samples[0]["simulation_time"], walking[0]["simulation_time"] - 2.)
    end = min(samples[-1]["simulation_time"], walking[-1]["simulation_time"] + 4.5)
    chosen = [s for s in samples if start <= s["simulation_time"] <= end]
    gaps = np.diff([s["simulation_time"] for s in chosen])
    if not len(gaps) or max(gaps) > .16:
        raise ValueError("telemetry gaps exceed 160ms; record the gateway at 20Hz")
    if chosen[-1]["simulation_time"] - chosen[0]["simulation_time"] < 15:
        raise ValueError("capture at least two seconds before walking and 4.5 seconds of real standing afterward")
    if chosen[-1].get("fallen") or set(chosen[-1].get("contact_steps", [])) != {"step0", "step1", "step2"}:
        raise ValueError("source recording does not demonstrate all stair contacts and upright arrival")
    if chosen[-1]["qpos"][0] < 3.2 or chosen[-1]["qpos"][2] < .4:
        raise ValueError("source recording did not physically reach the raised landing")
    settled = [s for s in chosen if s["simulation_time"] > walking[-1]["simulation_time"] + 1.]
    for sample in settled:
        feet = {c["foot"] for c in sample.get("foot_contacts", []) if c["normal_force_n"] > 1.}
        if sample.get("mode") != "stance" or len(feet) < 3 or np.linalg.norm(sample["qvel"][:3]) > .05:
            raise ValueError("standing tail lacks actual loaded support or remains in motion")
    return chosen, float(max(gaps))


def render(assets, samples, output, fps=25, width=960, height=540):
    controller = Controller(assets)
    model = controller.model
    # These settings affect only the external presentation camera, not geometry,
    # collisions, model dimensions, trajectory or the robot's inspection camera.
    model.vis.global_.offwidth, model.vis.global_.offheight = width, height
    model.vis.quality.offsamples = 1
    model.vis.headlight.ambient[:] = [.5, .5, .5]
    model.vis.headlight.diffuse[:] = [.75, .75, .75]
    model.vis.headlight.specular[:] = [.15, .15, .15]
    camera = mujoco.MjvCamera()
    camera.type = mujoco.mjtCamera.mjCAMERA_FREE
    camera.lookat[:] = [.5, 0., .25]
    camera.distance = 3.25
    camera.azimuth = 75.
    camera.elevation = -18.
    renderer = mujoco.Renderer(model, height=height, width=width)
    times = np.array([sample["simulation_time"] for sample in samples])
    duration = float(times[-1] - times[0])
    if duration > 25:
        raise ValueError("bounded demo must be at most 25 seconds of actual source time")
    frames = math.floor(duration * fps) + 1
    preview_sample = samples[int(np.searchsorted(times, times[0] + 6., side="right") - 1)]
    controller.data.qpos[:] = preview_sample["qpos"]
    controller.data.qvel[:] = preview_sample["qvel"]
    camera.lookat[0] = preview_sample["qpos"][0] + .5
    mujoco.mj_forward(model, controller.data)
    renderer.update_scene(controller.data, camera=camera)
    output.with_suffix(".preview.ppm").write_bytes(f"P6\n{width} {height}\n255\n".encode() + renderer.render().tobytes())
    log_path = output.with_suffix(".ffmpeg.log")
    with log_path.open("wb") as log:
        encoder = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-crf", "25",
            "-maxrate", "1100k", "-bufsize", "2200k", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(output)], stdin=subprocess.PIPE, stderr=log)
        try:
            for frame in range(frames):
                target_time = times[0] + frame / fps
                index = int(np.searchsorted(times, target_time, side="right") - 1)
                sample = samples[max(0, index)]
                # This isolated renderer replays the complete measured state.
                # It does not run control or substitute poses in the live engine.
                controller.data.qpos[:] = sample["qpos"]
                controller.data.qvel[:] = sample["qvel"]
                controller.data.time = sample["simulation_time"]
                camera.lookat[0] = sample["qpos"][0] + .5
                mujoco.mj_forward(model, controller.data)
                renderer.update_scene(controller.data, camera=camera)
                encoder.stdin.write(renderer.render().tobytes())
            encoder.stdin.close()
            if encoder.wait(timeout=30):
                raise RuntimeError("ffmpeg failed; see " + str(log_path))
        finally:
            if encoder.poll() is None:
                encoder.kill()
                encoder.wait()
            renderer.close()
            controller.close()
    if output.stat().st_size > 3_000_000:
        raise ValueError("video exceeds 3 MB web budget")
    poster = output.with_suffix(".poster.png")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", "6",
                    "-i", str(output), "-frames:v", "1", str(poster)], check=True)
    return {"duration_s": frames / fps, "fps": fps, "width": width, "height": height,
            "bytes": output.stat().st_size, "sha256": sha256(output), "poster": poster.name,
            "state_sampling": "preceding recorded state at 25Hz; no interpolated or invented joint positions",
            "camera": {"lookat": camera.lookat.tolist(), "distance": float(camera.distance),
                       "azimuth": float(camera.azimuth), "elevation": float(camera.elevation),
                       "tracking": "lookat.x = measured local base x + 0.5m; y=0,z=0.25m"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--map", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--trace", type=Path, help="actual runner JSON with complete measured qpos/qvel")
    parser.add_argument("--provenance", type=Path, help="optional asset-verification sidecar bound to the trace SHA-256")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    semantic_map = json.loads(args.map.read_text())
    if args.trace:
        raw = json.loads(args.trace.read_text())
        source_path = args.trace
        source_kind = ("independent_gateway_controller_probe" if raw.get("source_kind") == "independent_gateway_controller_probe"
                       else "recorded_gateway_physics")
        if args.provenance:
            sidecar = json.loads(args.provenance.read_text())
            if sidecar.get("source_sha256") != sha256(source_path):
                raise ValueError("asset verification sidecar is not bound to this exact source recording")
            raw["physics_provenance"] = sidecar["physics_provenance"]
    else:
        raw = record_probe(args.assets, semantic_map)
        source_path = args.output.with_suffix(".physics.json")
        source_path.write_text(json.dumps(raw, separators=(",", ":")))
        source_kind = raw["source_kind"]
    validate_source(raw, semantic_map)
    controller = Controller(args.assets)
    samples, maximum_gap = select_samples(raw, controller.model)
    controller.close()
    video = render(args.assets, samples, args.output)
    manifest = {"source_kind": source_kind, "source_sha256": sha256(source_path),
                "source_file": source_path.name, "map_digest": map_digest(semantic_map),
                "source_provenance_sha256": sha256(args.provenance) if args.provenance else None,
                "policy_commit": WTW_COMMIT, "policy_sha256": POLICY_SHA256,
                "model_commit": MODEL_COMMIT, "mujoco_version": mujoco.__version__,
                "license_reference": "simulation/quadruped/THIRD_PARTY.md",
                "source_round_id": raw.get("round", {}).get("id"),
                "source_mission_ids": [mission["id"] for mission in raw.get("missions", [])],
                "simulation_world": "MuJoCo world; separate from the Gazebo rover world",
                "video": video, "maximum_source_gap_s": maximum_gap,
                "source_simulation_start_s": samples[0]["simulation_time"],
                "source_simulation_end_s": samples[-1]["simulation_time"],
                "first_physics": samples[0], "last_physics": samples[-1],
                "max_tilt_rad": max(s["tilt"] for s in samples),
                "max_motor_torque_nm": max(s["max_motor_torque"] for s in samples),
                "claims": "External-camera rendering of recorded joint dynamics; no generated imagery or success overlays."}
    args.output.with_suffix(".provenance.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"source_kind": source_kind, **video}), flush=True)


if __name__ == "__main__":
    main()
