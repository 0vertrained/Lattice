#!/usr/bin/env python3
"""Install checksum-pinned assets; convert the checkpoint once, without Torch.

Runtime code never unpickles. This installer accepts only the exact reviewed
checkpoint hash and a tiny tensor-only unpickler, then writes a checked NPZ.
Downloads use normal HTTPS trust and the environment's existing proxy settings.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
from pathlib import Path
import pickle
import urllib.request
import zipfile

import numpy as np

try:
    from .policy import POLICY_SHA256, SHAPES
except ImportError:
    from policy import POLICY_SHA256, SHAPES

WTW_COMMIT = "0e7236bdc81ce855cbe3d70345a7899452bdeb1c"
MODEL_COMMIT = "b0655057a9df2abe39ea7fc989914ba6f248301c"
CHECKPOINT_PATH = "runs/gait-conditioned-agility/pretrain-v0/train/025417.456545/checkpoints/ac_weights_last.pt"
# destination, repository, commit, source, exact bytes, SHA-256
FILES = (
    ("checkpoint.pt", "Improbable-AI/walk-these-ways", WTW_COMMIT, CHECKPOINT_PATH, 12225632, "d1542b0b8c7b767753a286f1cbabe5b4dc86e67611fb95844e870b3c61f8869e"),
    ("WTW-LICENSE", "Improbable-AI/walk-these-ways", WTW_COMMIT, "LICENSE", 1265, "7dc66e1919dbcc2b49af464ceac3518b230e0e253d57988d418e23f01ef675b9"),
    ("unitree_go1/LICENSE", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/LICENSE", 1559, "2b794acf1e250f5545ae5a47d81e5685ea5488ce077d1087ed8be5f81e9ba5c0"),
    ("unitree_go1/go1.xml", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/go1.xml", 10875, "d5a7466784c8e72fd174cc7fa5a92754a1a0a6d458a1dec79e7ca0abc9525c4a"),
    ("unitree_go1/assets/trunk.stl", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/assets/trunk.stl", 5619284, "051a57995dc6f892fc9bc53cd94e9a894f3dc209fd646e94d55d764150013970"),
    ("unitree_go1/assets/thigh_mirror.stl", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/assets/thigh_mirror.stl", 950834, "1a90b89de47a57cb12a2d703f6b008a6ace8a1890a381c27723296fd0d00b9d8"),
    ("unitree_go1/assets/thigh.stl", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/assets/thigh.stl", 793584, "bbf7c0a441323088c59276dbec8a32e708a1c61f42d30a6f6775176366ea23f8"),
    ("unitree_go1/assets/hip.stl", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/assets/hip.stl", 1505284, "b6599b9dd2751ebd87449203223f5683a6c235268b76fcc443e00e0d974a06c0"),
    ("unitree_go1/assets/calf.stl", "google-deepmind/mujoco_menagerie", MODEL_COMMIT, "unitree_go1/assets/calf.stl", 1447984, "ad3685e132454fd64e4ca3e5089f0d812fb53958e95c14913a22e3193e9e9ed8"),
)


def checked(data, size, digest):
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("asset size/checksum mismatch")
    return data


def _tensor(storage, offset, shape, stride, *_):
    if (not isinstance(storage, np.ndarray) or len(shape) > 3 or len(shape) != len(stride)
            or not isinstance(offset, int) or offset < 0
            or any(not isinstance(s, int) or s <= 0 or s > 100000 for s in shape)
            or any(not isinstance(s, int) or s < 0 for s in stride)):
        raise ValueError("invalid checkpoint tensor layout")
    end = offset + sum((s - 1) * t for s, t in zip(shape, stride)) + 1
    if end > storage.size:
        raise ValueError("checkpoint tensor outside storage")
    return np.lib.stride_tricks.as_strided(storage[offset:], shape=shape,
        strides=tuple(t * 4 for t in stride)).copy()


class _TensorReader(pickle.Unpickler):
    def __init__(self, data, archive):
        super().__init__(data)
        self.archive = archive

    def find_class(self, module, name):
        allowed = {("collections", "OrderedDict"): collections.OrderedDict,
                   ("torch._utils", "_rebuild_tensor_v2"): _tensor,
                   ("torch", "FloatStorage"): np.float32}
        if (module, name) not in allowed:
            raise ValueError("unexpected checkpoint pickle global")
        return allowed[module, name]

    def persistent_load(self, value):
        if (not isinstance(value, tuple) or len(value) != 5 or value[0] != "storage"
                or value[1] is not np.float32 or not str(value[2]).isdigit()
                or not isinstance(value[4], int) or not 0 < value[4] < 4000000):
            raise ValueError("unexpected checkpoint storage")
        raw = self.archive.read("archive/data/" + value[2])
        if len(raw) != value[4] * 4:
            raise ValueError("checkpoint storage length mismatch")
        return np.frombuffer(raw, dtype=np.float32)


def convert(checkpoint, output):
    """The hash is checked before any checkpoint deserialization takes place."""
    data = checked(Path(checkpoint).read_bytes(), FILES[0][4], FILES[0][5])
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        weights = _TensorReader(io.BytesIO(archive.read("archive/data.pkl")), archive).load()
    selected = {}
    for name, shape in SHAPES.items():
        value = weights[name]
        if value.dtype != np.float32 or value.shape != shape or not np.isfinite(value).all():
            raise ValueError("invalid policy tensor")
        selected[name] = value
    buffer = io.BytesIO()
    np.savez_compressed(buffer, **selected)
    raw = buffer.getvalue()
    if hashlib.sha256(raw).hexdigest() != POLICY_SHA256:
        raise ValueError("converted policy checksum mismatch (use pinned NumPy version)")
    Path(output).write_bytes(raw)


def verify(directory):
    directory = Path(directory)
    for relative, _, _, _, size, digest in FILES:
        checked((directory / relative).read_bytes(), size, digest)
    policy = (directory / "policy.npz").read_bytes()
    if hashlib.sha256(policy).hexdigest() != POLICY_SHA256:
        raise ValueError("converted policy checksum mismatch")


def install(directory, source=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for relative, repository, commit, source_path, size, digest in FILES:
        path = directory / relative
        url = f"https://raw.githubusercontent.com/{repository}/{commit}/{source_path}"
        if path.exists():
            checked(path.read_bytes(), size, digest)
        else:
            if source:
                clone = "walk-these-ways" if repository.startswith("Improbable") else "menagerie"
                raw = (Path(source) / clone / source_path).read_bytes()
            else:
                with urllib.request.urlopen(url, timeout=60) as response:
                    raw = response.read(size + 1)
            checked(raw, size, digest)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".partial")
            temporary.write_bytes(raw)
            temporary.replace(path)
        records.append({"path": relative, "url": url, "sha256": digest, "bytes": size})
    convert(directory / "checkpoint.pt", directory / "policy.npz")
    (directory / "provenance.json").write_text(json.dumps({"assets": records,
        "runtime_policy_sha256": POLICY_SHA256, "numpy_version": np.__version__}, indent=2) + "\n")
    verify(directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, help="optional offline clone directory; all hashes still checked")
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    if arguments.verify:
        verify(arguments.output)
    else:
        install(arguments.output, arguments.source)
    print(f"Verified pinned quadruped assets: {arguments.output}")
