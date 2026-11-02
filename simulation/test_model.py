"""Mechanical invariants for the differential-drive rover, independent of ROS."""
import math
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent / 'warehouse'


class RoverGeometryTests(unittest.TestCase):
    def setUp(self):
        self.model = ET.parse(ROOT / 'rover.sdf').getroot().find('model')

    def test_wheel_axes_are_parallel_to_the_model_axle(self):
        # An unspecified axis frame inherits the child wheel's 90-degree roll.
        # That rotates a local y axis into z and prevents correct rolling.
        for joint in self.model.findall('joint[@type="revolute"]'):
            axis = joint.find('axis/xyz')
            x, y, z = map(float, axis.text.split())
            if axis.get('expressed_in') != '__model__':
                child = self.model.find(f'link[@name="{joint.findtext("child")}"]')
                roll = float(child.findtext('pose').split()[3])
                y, z = y*math.cos(roll)-z*math.sin(roll), y*math.sin(roll)+z*math.cos(roll)
            self.assertAlmostEqual(x, 0)
            self.assertAlmostEqual(abs(y), 1)
            self.assertAlmostEqual(z, 0)

    def test_controller_dimensions_match_physical_wheels(self):
        drive = self.model.find('plugin[@name="gz::sim::systems::DiffDrive"]')
        wheel_y = []
        for name in ('left_wheel', 'right_wheel'):
            wheel = self.model.find(f'link[@name="{name}"]')
            wheel_y.append(float(wheel.findtext('pose').split()[1]))
            radius = float(wheel.findtext('collision/geometry/cylinder/radius'))
            self.assertAlmostEqual(radius, float(drive.findtext('wheel_radius')))
        self.assertAlmostEqual(abs(wheel_y[0]-wheel_y[1]), float(drive.findtext('wheel_separation')))


if __name__ == '__main__':
    unittest.main()
