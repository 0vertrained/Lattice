#!/usr/bin/env bash
# Run inside the pinned Nav2 development image, with the checkout mounted at /work.
set -eo pipefail
source /opt/ros/jazzy/setup.bash
cd /work
export CMAKE_BUILD_PARALLEL_LEVEL=2
colcon --log-base target/nav2-log build --base-paths /opt/overlay_ws/src/navigation2 \
  --build-base target/nav2-build --install-base target/nav2-install --merge-install \
  --parallel-workers 2 --packages-up-to nav2_amcl nav2_map_server nav2_planner \
  nav2_navfn_planner nav2_controller nav2_regulated_pure_pursuit_controller \
  nav2_behaviors nav2_bt_navigator nav2_lifecycle_manager \
  --cmake-args -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
source target/nav2-install/setup.bash
colcon --log-base target/gateway-log build --base-paths services/lattice-ros2-gateway \
  --build-base target/gateway-build --install-base target/gateway-install --merge-install \
  --cmake-args -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
ctest --test-dir target/gateway-build/lattice_ros2_gateway --output-on-failure
cmake -S simulation/watchdog -B target/nav2-watchdog -DCMAKE_BUILD_TYPE=Release
cmake --build target/nav2-watchdog -j 2
python3 simulation/warehouse/generate_world.py
