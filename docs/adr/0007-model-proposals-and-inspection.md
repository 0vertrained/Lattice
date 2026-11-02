# ADR 0007: Model proposals, backend approval and camera evidence

Status: accepted for the isolated simulation demo.

The browser-only review flow could be bypassed by posting directly to the mission
endpoint, and the Python service returned a keyword-based placeholder. Inspection
also had no sensor evidence. Add an executable, measurable ML/robotics path.

Use a locally trained TF-IDF/logistic-regression intent baseline and a synthetic
silhouette marker detector. These models run on CPU without external credentials
or weight downloads, have versioned training data/seeds and held-out evaluation,
and expose a small contract that future language/vision models can replace.
The classifier probability is not a safety guarantee; vision confidence is only
calibrated on synthetic crops. Do not describe either as an LLM/VLM.

All externally created missions require a stored proposal and approval of its
exact digest. The digest binds timestamps, identity, content and provenance.
Only the server loads the executable command. An atomic in-memory reservation
prevents duplicate dispatch on concurrent approvals. Interrupted approval fails
closed; durable transactions remain Milestone 1 work. The shared development key
does not distinguish human operators from devices.

Signed `Inspect` navigates at 0.3 m/s and then captures a post-arrival RGB frame.
C++ owns ROS sensor acquisition; Rust binds the capture to the signed command;
Python detects; Rust validates bounded evidence before attaching it to the mission.
Inference cannot publish ROS commands and its credential-free HTTP request runs
asynchronously so model latency does not block the body's motion lease.

The frontend renders annotated images and downloads the complete session trace.
Raw captures remain in the private run directory; production evidence storage,
retention, authentication, signed capture attestations and calibrated real-camera
models remain future work. Keep real simulator evidence distinct from generated
presentation material.
