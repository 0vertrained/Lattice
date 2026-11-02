"""Headless warehouse navigation. All ROS velocity output passes the local gate."""
from pathlib import Path
import tempfile
import os
import yaml
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node


def generate_launch_description():
    root = Path(__file__).resolve().parent
    params_path = os.getenv('LATTICE_NAV2_PARAMS')
    if params_path is None:
        params_path = str(Path(get_package_share_directory('nav2_bringup')) / 'params/nav2_params.yaml')
    params = yaml.safe_load(Path(params_path).read_text())
    amcl = params['amcl']['ros__parameters']
    amcl.update(base_frame_id='base_link', set_initial_pose=True, always_reset_initial_pose=True,
                initial_pose={'x': 0.0, 'y': 0.0, 'z': 0.0, 'yaw': 0.0})
    params['bt_navigator']['ros__parameters']['robot_base_frame'] = 'base_link'
    controller = params['controller_server']['ros__parameters']
    controller['enable_stamped_cmd_vel'] = False
    controller['controller_plugins'] = ['FollowPath']
    controller['FollowPath'] = {
        'plugin': 'nav2_regulated_pure_pursuit_controller::RegulatedPurePursuitController',
        'desired_linear_vel': 0.3, 'lookahead_dist': 0.5, 'min_lookahead_dist': 0.3,
        'max_lookahead_dist': 0.8, 'transform_tolerance': 0.2,
        'use_rotate_to_heading': True, 'rotate_to_heading_angular_vel': 0.5,
        'use_collision_detection': True, 'max_allowed_time_to_collision_up_to_carrot': 1.0,
    }
    for name in ('local_costmap', 'global_costmap'):
        costmap = params[name][name]['ros__parameters']
        costmap.update(robot_base_frame='base_link', robot_radius=0.25)
        costmap['inflation_layer']['inflation_radius'] = 0.5
    params['behavior_server']['ros__parameters']['robot_base_frame'] = 'base_link'
    params['behavior_server']['ros__parameters']['enable_stamped_cmd_vel'] = False
    params['velocity_smoother']['ros__parameters'].update(
        enable_stamped_cmd_vel=False, max_velocity=[0.4, 0.0, 0.8], min_velocity=[-0.2, 0.0, -0.8])
    # Build a local parameter file; never modify Nav2's installed defaults.
    generated = Path(tempfile.gettempdir()) / 'lattice-nav2.yaml'
    generated.write_text(yaml.safe_dump(params))
    managed = ['map_server', 'amcl', 'planner_server', 'controller_server', 'behavior_server', 'bt_navigator']
    navigation = []
    for package, name in [
        ('nav2_map_server', 'map_server'), ('nav2_amcl', 'amcl'),
        ('nav2_planner', 'planner_server'), ('nav2_controller', 'controller_server'),
        ('nav2_behaviors', 'behavior_server'), ('nav2_bt_navigator', 'bt_navigator'),
    ]:
        navigation.append(Node(package=package, executable=name, name=name,
            parameters=[str(generated), {'use_sim_time': True, 'yaml_filename': str(root/'map.yaml')}],
            remappings=[('cmd_vel', 'cmd_vel_nav')], output='screen'))
    return LaunchDescription([
        ExecuteProcess(cmd=['gz', 'sim', '-s', '-r', '--headless-rendering', str(root/'world.sdf')], output='screen'),
        Node(package='ros_gz_bridge', executable='parameter_bridge', parameters=[{'config_file': str(root/'bridge.yaml')}]),
        Node(package='robot_state_publisher', executable='robot_state_publisher', parameters=[{
            'use_sim_time': True, 'robot_description': (root/'rover.urdf').read_text()}]),
        *navigation,
        Node(package='nav2_lifecycle_manager', executable='lifecycle_manager', name='lifecycle_manager',
            parameters=[{'use_sim_time': True, 'autostart': True, 'node_names': managed}]),
        Node(package='lattice_ros2_gateway', executable='lattice_ros2_gateway', parameters=[{
            'use_sim_time': True, 'locations_file': str(root/'locations.json'),
            'socket_path': os.getenv('LATTICE_ROS_SOCKET', '/run/lattice/gateway.sock')}], output='screen'),
    ])
