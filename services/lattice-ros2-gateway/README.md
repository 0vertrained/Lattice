# Lattice ROS 2 Gateway

C++/`rclcpp` owns the ROS boundary because this process integrates with Nav2,
sensor pipelines, vendor SDKs, and body-local safety nodes.

The gateway is not internet-facing. It receives authenticated, signed, typed
commands from a local body agent, maps them to ROS actions, and reports bounded
progress and results.

The initial scaffold intentionally exposes no movement publisher.

Next implementation:

1. Generate the body-stream gRPC client from `proto/`.
2. Verify the mTLS body lease and signed command.
3. Map `Navigate` to Nav2 `NavigateToPose`.
4. Add command-expiry and sequence checks locally.
5. Add a watchdog and E-stop subscription.
6. Enforce body-local speed and geofence policy.
7. Report evidence references rather than secrets or unbounded payloads.
