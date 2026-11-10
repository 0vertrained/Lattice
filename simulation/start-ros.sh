#!/usr/bin/env bash
set -eo pipefail
# The container runs under the invoking user's ID, which has a home in this image only when it is 1000.
# Gazebo writes its log under HOME and crashes at startup when it cannot, so give it one it can write.
[[ -w "${HOME:-/}" ]] || export HOME=/tmp/lattice-home
mkdir -p "$HOME"
# Gazebo's transport groups processes by host and user name, and gives each process a random name of its own
# when the ID has no user: the bridge then never hears the simulator. Name the partition, one per container.
export GZ_PARTITION="${GZ_PARTITION:-$(hostname):lattice}"
source /opt/ros/jazzy/setup.bash
source /work/target/nav2-install/setup.bash
source /work/target/gateway-install/setup.bash
export GZ_SIM_SYSTEM_PLUGIN_PATH="/work/target/nav2-watchdog:${GZ_SIM_SYSTEM_PLUGIN_PATH:-}"
export LIBGL_ALWAYS_SOFTWARE=1
export LATTICE_NAV2_PARAMS=/opt/overlay_ws/src/navigation2/nav2_bringup/params/nav2_params.yaml
cd /work
exec ros2 launch simulation/warehouse/warehouse.launch.py
