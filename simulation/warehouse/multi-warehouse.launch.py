"""Two real rover bodies in one world, each behind its own local safety gate."""
import os
from pathlib import Path
import sys
import yaml

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from generate_world import generate
from multi_robot import ROBOTS, bridge_config, nav2_parameters, robot_model


def generate_launch_description():
    run = Path(os.getenv('LATTICE_ROS_RUN_DIR', '/run/lattice'))
    run.mkdir(parents=True, exist_ok=True)
    world = run / 'world.sdf'
    for asset in ('map.pgm', 'marker.dae'):
        if not (ROOT / asset).is_file():
            raise RuntimeError(f'Missing warehouse asset {asset}; run simulation/build-ros.sh first')
    # Build-time assets can be root-owned. Runtime only writes its own run dir.
    generate([robot_model(robot) for robot in ROBOTS], world, write_assets=False)
    bridge = run / 'bridge.yaml'
    bridge.write_text(yaml.safe_dump(bridge_config()))
    params_path = os.getenv('LATTICE_NAV2_PARAMS')
    if params_path is None:
        params_path = str(Path(get_package_share_directory('nav2_bringup')) / 'params/nav2_params.yaml')
    template = yaml.safe_load(Path(params_path).read_text())
    nodes = [
        ExecuteProcess(cmd=['gz', 'sim', '-s', '-r', '--headless-rendering', str(world)], output='screen'),
        Node(package='ros_gz_bridge', executable='parameter_bridge',
             parameters=[{'config_file': str(bridge)}], output='screen'),
    ]
    managed = ['map_server', 'amcl', 'planner_server', 'controller_server',
               'behavior_server', 'bt_navigator']
    for robot in ROBOTS:
        namespace = robot['namespace']
        params = run / f'{namespace}-nav2.yaml'
        params.write_text(yaml.safe_dump(nav2_parameters(template, robot)))
        nodes.append(Node(
            package='robot_state_publisher', executable='robot_state_publisher',
            namespace=namespace, parameters=[{'use_sim_time': True,
                'frame_prefix': namespace + '/',
                'robot_description': (ROOT / 'rover.urdf').read_text()}]))
        for package, name in [
            ('nav2_map_server', 'map_server'), ('nav2_amcl', 'amcl'),
            ('nav2_planner', 'planner_server'), ('nav2_controller', 'controller_server'),
            ('nav2_behaviors', 'behavior_server'), ('nav2_bt_navigator', 'bt_navigator')]:
            nodes.append(Node(package=package, executable=name, name=name, namespace=namespace,
                parameters=[str(params), {'use_sim_time': True, 'yaml_filename': str(ROOT / 'map.yaml')}],
                remappings=[('cmd_vel', 'cmd_vel_nav')], output='screen'))
        nodes.extend([
            Node(package='nav2_lifecycle_manager', executable='lifecycle_manager',
                 name='lifecycle_manager', namespace=namespace,
                 parameters=[{'use_sim_time': True, 'autostart': True, 'node_names': managed}]),
            Node(package='lattice_ros2_gateway', executable='lattice_ros2_gateway', namespace=namespace,
                 parameters=[{'use_sim_time': True, 'locations_file': str(ROOT / 'locations.json'),
                     'base_frame_id': namespace + '/base_link', 'map_frame_id': 'map',
                     'socket_path': str(run / namespace / 'gateway.sock')}], output='screen'),
        ])
    return LaunchDescription(nodes)
