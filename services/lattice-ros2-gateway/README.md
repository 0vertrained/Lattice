# Lattice ROS 2 navigation gateway

C++20 lifecycle node for the local Nav2 action boundary. The companion Rust
`lattice-ros2-body` verifies signed commands and forwards authorized navigation
over `/run/lattice/gateway.sock` (mode 0600). No HTTP listener or credentials are
present in this C++ process.

The node resolves destinations from `locations_file`, submits `NavigateToPose`,
tracks feedback/results, and reports map-frame localization. All navigation
velocity is routed through `cmd_vel_nav`; the gateway publishes bounded output
on `cmd_vel`. A steady-clock lease, command expiry, localization freshness,
velocity freshness and `lattice/emergency_stop` can stop motion. The independent
Gazebo watchdog forwards to `motor_cmd_vel` and stops on gateway loss.

Read [the design decision](../../docs/adr/0006-ros-navigation-adapter.md) and
[the runnable warehouse guide](../../docs/ROBOTICS_DEMO.md).
