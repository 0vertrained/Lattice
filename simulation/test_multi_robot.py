"""Regression checks for physical and control isolation of the two real rovers."""
from copy import deepcopy
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from simulation.warehouse.generate_world import BOXES, generate
from simulation.warehouse.multi_robot import ROBOTS, bridge_config, nav2_parameters, robot_model


class MultiRoverTests(unittest.TestCase):
    def test_runtime_world_generation_does_not_rewrite_build_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            models = [robot_model(robot) for robot in ROBOTS]
            with patch('simulation.warehouse.generate_world.ROOT', root):
                generate(models, root / 'world.sdf', write_assets=False)
            self.assertEqual([path.name for path in root.iterdir()], ['world.sdf'])
            world = ET.parse(root / 'world.sdf').getroot().find('world')
            for robot in ROBOTS:
                self.assertIsNotNone(world.find(f'model[@name="{robot["namespace"]}"]'))

    def test_motion_and_sensor_streams_are_disjoint(self):
        commands, motors, odometry, sensor_topics, frames = [], [], [], [], []
        for robot in ROBOTS:
            model = robot_model(robot)
            drive = model.find('plugin[@name="gz::sim::systems::DiffDrive"]')
            watchdog = model.find('plugin[@name="lattice::SimWatchdog"]')
            commands.append(watchdog.findtext('input_topic'))
            motors.append(watchdog.findtext('output_topic'))
            self.assertEqual(drive.findtext('topic'), motors[-1])
            odometry.append(drive.findtext('odom_topic'))
            frames.extend([drive.findtext('frame_id'), drive.findtext('child_frame_id')])
            for sensor in model.findall('link/sensor'):
                sensor_topics.append(sensor.findtext('topic'))
                frames.append(sensor.findtext('gz_frame_id'))
        for values in (commands, motors, odometry, sensor_topics, frames):
            self.assertEqual(len(set(values)), len(values))
        self.assertTrue(set(commands).isdisjoint(motors))
        bridges = bridge_config()
        self.assertEqual({b['gz_topic_name'] for b in bridges if b['direction'] == 'ROS_TO_GZ'}, set(commands))
        self.assertTrue(set(motors).isdisjoint({b['gz_topic_name'] for b in bridges}))
        for topic in odometry + sensor_topics:
            self.assertEqual(sum(b['gz_topic_name'] == topic for b in bridges), 1)

    def test_spawns_are_distinct_and_clear_of_static_geometry(self):
        positions = [robot['spawn'][:2] for robot in ROBOTS]
        self.assertGreater(math.dist(*positions), 1.)
        for x, y in positions:
            for bx, by, width, depth in BOXES:
                clearance = math.hypot(max(abs(x - bx) - width / 2, 0),
                                       max(abs(y - by) - depth / 2, 0))
                self.assertGreater(clearance, .5)

    def test_other_rover_is_visible_at_lidar_height_without_self_hits(self):
        for robot in ROBOTS:
            model = robot_model(robot)
            sensor = model.find('link/sensor[@name="lidar"]')
            scan_z = float(sensor.findtext('pose').split()[2])
            near_clip = float(sensor.findtext('lidar/range/min'))
            housing = model.find('link/visual[@name="sensor_housing"]')
            housing_z = float(housing.findtext('pose').split()[2])
            width, depth, height = map(float, housing.findtext('geometry/box/size').split())
            self.assertLess(abs(scan_z - housing_z), height / 2)
            self.assertLess(math.hypot(width / 2, depth / 2), near_clip)

    def test_nav2_uses_one_map_and_per_robot_frames_and_sensors(self):
        template = {name: {'ros__parameters': {}} for name in
                    ('amcl', 'bt_navigator', 'controller_server', 'behavior_server')}
        for name, layer in [('local_costmap', 'voxel_layer'), ('global_costmap', 'obstacle_layer')]:
            template[name] = {name: {'ros__parameters': {
                'inflation_layer': {}, layer: {'scan': {'topic': '/scan'}}}}}
        original = deepcopy(template)
        for robot in ROBOTS:
            namespace = robot['namespace']
            params = nav2_parameters(template, robot)[namespace]
            amcl = params['amcl']['ros__parameters']
            self.assertEqual(amcl['global_frame_id'], 'map')
            self.assertEqual(amcl['base_frame_id'], namespace + '/base_link')
            self.assertEqual(amcl['odom_frame_id'], namespace + '/odom')
            self.assertEqual((amcl['initial_pose']['x'], amcl['initial_pose']['y']), robot['spawn'][:2])
            self.assertEqual(params['bt_navigator']['ros__parameters']['odom_topic'], '/' + namespace + '/odom')
            self.assertEqual(params['behavior_server']['ros__parameters']['local_frame'], namespace + '/odom')
            for name, layer in [('local_costmap', 'voxel_layer'), ('global_costmap', 'obstacle_layer')]:
                costmap = params[name][name]['ros__parameters']
                self.assertEqual(costmap['robot_base_frame'], namespace + '/base_link')
                self.assertEqual(costmap[layer]['scan']['topic'], '/' + namespace + '/scan')
                self.assertEqual(costmap['static_layer']['map_topic'], '/' + namespace + '/map')
                self.assertTrue(costmap['use_sim_time'])
        self.assertEqual(template, original)


if __name__ == '__main__':
    unittest.main()
