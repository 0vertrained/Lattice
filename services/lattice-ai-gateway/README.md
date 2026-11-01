# Lattice AI Gateway

This Python process is deliberately outside the trusted command path.

It may:

- transcribe speech
- run LLM/VLM inference
- propose a typed skill plan
- attach confidence, rationale, and evidence references

It may not:

- access body credentials
- access command-signing keys
- publish ROS actuator topics
- update mission state directly
- bypass policy or human approval

The Rust core validates every proposal before creating a signed command.
