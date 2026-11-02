"""Two physical rover instances, isolated topics/TF, and one warehouse frame.

Pure configuration helpers keep launch-time wiring testable without ROS.
"""
from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
ROBOTS = (
    {'namespace': 'rover_a', 'body_id': 'gazebo-rover-a',
     'spawn': (0.0, 0.0, 0.0), 'color': '0.1 0.6 0.9 1'},
    {'namespace': 'rover_b', 'body_id': 'gazebo-rover-b',
     'spawn': (-1.5, -1.5, 0.0), 'color': '0.9 0.65 0.1 1'},
)


def robot_model(robot):
    namespace = robot['namespace']
    model = ET.parse(ROOT / 'rover.sdf').getroot().find('model')
    model.set('name', namespace)
    x, y, yaw = robot['spawn']
    model.find('pose').text = f'{x} {y} 0.09 0 0 {yaw}'
    model.find('link/visual/material/diffuse').text = robot['color']
    # The original chassis sits below the lidar plane. A compact sensor housing
    # makes the other real rover visible to obstacle layers. Its own surface is
    # inside the lidar's 8 cm near clip, avoiding a self-obstacle in every scan.
    base_link = model.find('link[@name="base_link"]')
    for kind in ('collision', 'visual'):
        housing = ET.SubElement(base_link, kind, name='sensor_housing')
        ET.SubElement(housing, 'pose').text = '0 0 0.22 0 0 0'
        geometry = ET.SubElement(housing, 'geometry')
        ET.SubElement(ET.SubElement(geometry, 'box'), 'size').text = '0.1 0.1 0.16'
        if kind == 'visual':
            ET.SubElement(ET.SubElement(housing, 'material'), 'diffuse').text = robot['color']
    for sensor in model.findall('link/sensor'):
        sensor.find('topic').text = f'/{namespace}/{sensor.findtext("topic")}'
        sensor.find('gz_frame_id').text = f'{namespace}/{sensor.findtext("gz_frame_id")}'
    drive = model.find('plugin[@name="gz::sim::systems::DiffDrive"]')
    for key, topic in [('topic', 'motor_cmd_vel'), ('odom_topic', 'odom')]:
        drive.find(key).text = f'/{namespace}/{topic}'
    # Shared TF transport carries disjoint trees rooted at the common map.
    drive.find('tf_topic').text = '/tf'
    for key in ('frame_id', 'child_frame_id'):
        drive.find(key).text = f'{namespace}/{drive.findtext(key)}'
    watchdog = model.find('plugin[@name="lattice::SimWatchdog"]')
    ET.SubElement(watchdog, 'input_topic').text = f'/{namespace}/cmd_vel'
    ET.SubElement(watchdog, 'output_topic').text = f'/{namespace}/motor_cmd_vel'
    return model


def bridge_config():
    def entry(topic, ros_type, gz_type, direction='GZ_TO_ROS'):
        return dict(ros_topic_name=topic, gz_topic_name=topic,
                    ros_type_name=ros_type, gz_type_name=gz_type, direction=direction)
    result = [entry('/clock', 'rosgraph_msgs/msg/Clock', 'gz.msgs.Clock'),
              entry('/tf', 'tf2_msgs/msg/TFMessage', 'gz.msgs.Pose_V')]
    for robot in ROBOTS:
        prefix = '/' + robot['namespace']
        result.extend([
            entry(prefix + '/scan', 'sensor_msgs/msg/LaserScan', 'gz.msgs.LaserScan'),
            entry(prefix + '/odom', 'nav_msgs/msg/Odometry', 'gz.msgs.Odometry'),
            entry(prefix + '/camera/image', 'sensor_msgs/msg/Image', 'gz.msgs.Image'),
            entry(prefix + '/cmd_vel', 'geometry_msgs/msg/Twist', 'gz.msgs.Twist', 'ROS_TO_GZ'),
        ])
    return result


def nav2_parameters(template, robot):
    params = deepcopy(template)
    namespace = robot['namespace']
    base, odom = f'{namespace}/base_link', f'{namespace}/odom'
    x, y, yaw = robot['spawn']
    params['amcl']['ros__parameters'].update(
        base_frame_id=base, odom_frame_id=odom, global_frame_id='map',
        scan_topic=f'/{namespace}/scan', set_initial_pose=True,
        always_reset_initial_pose=True, initial_pose={'x': x, 'y': y, 'z': 0., 'yaw': yaw})
    params['bt_navigator']['ros__parameters'].update(
        robot_base_frame=base, global_frame='map', odom_topic=f'/{namespace}/odom')
    controller = params['controller_server']['ros__parameters']
    controller.update(enable_stamped_cmd_vel=False, controller_plugins=['FollowPath'])
    controller['FollowPath'] = {
        'plugin': 'nav2_regulated_pure_pursuit_controller::RegulatedPurePursuitController',
        'desired_linear_vel': .3, 'lookahead_dist': .5, 'min_lookahead_dist': .3,
        'max_lookahead_dist': .8, 'transform_tolerance': .2,
        'use_rotate_to_heading': True, 'rotate_to_heading_angular_vel': .5,
        'use_collision_detection': True, 'max_allowed_time_to_collision_up_to_carrot': 1.,
    }
    for name in ('local_costmap', 'global_costmap'):
        costmap = params[name][name]['ros__parameters']
        costmap.update(robot_base_frame=base, robot_radius=.25,
                       global_frame=odom if name == 'local_costmap' else 'map')
        costmap['inflation_layer']['inflation_radius'] = .5
        for layer in ('voxel_layer', 'obstacle_layer'):
            if layer in costmap:
                costmap[layer]['scan']['topic'] = f'/{namespace}/scan'
        costmap.setdefault('static_layer', {})['map_topic'] = f'/{namespace}/map'
    params['behavior_server']['ros__parameters'].update(
        robot_base_frame=base, local_frame=odom, global_frame='map',
        enable_stamped_cmd_vel=False)

    def use_clock(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'ros__parameters':
                    child['use_sim_time'] = True
                else:
                    use_clock(child)
    use_clock(params)
    # Match /rover_a/local_costmap/local_costmap as well as top-level nodes.
    return {namespace: params}
