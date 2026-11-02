#!/usr/bin/env python3
"""Generate matching Gazebo geometry and occupancy map without external assets."""
from pathlib import Path
import xml.etree.ElementTree as ET
import math

ROOT = Path(__file__).resolve().parent
# x, y, width, depth; same geometry supplies the simulator and static map.
BOXES = [(0, -4, 10.2, .2), (0, 4, 10.2, .2), (-5, 0, .2, 8), (5, 0, .2, 8), (2, 0, .7, 1.8)]

def generate():
    obstacles = []
    for i, (x, y, width, depth) in enumerate(BOXES):
        obstacles.append(f'''<model name="obstacle_{i}"><static>true</static><pose>{x} {y} 0.5 0 0 0</pose>
<link name="box"><collision name="collision"><geometry><box><size>{width} {depth} 1</size></box></geometry></collision>
<visual name="visual"><geometry><box><size>{width} {depth} 1</size></box></geometry><material><diffuse>0.3 0.4 0.5 1</diffuse></material></visual></link></model>''')
    # A simple octagonal safety marker, learned from silhouettes rather than text.
    # Visual-only, flush with the existing north wall, so map geometry is unchanged.
    vertices = [(0., 0., 0.)] + [(.35*math.cos(math.pi/8+i*math.pi/4), 0.,
                                 .35*math.sin(math.pi/8+i*math.pi/4)) for i in range(8)]
    # COLLADA binds an explicit material and normals. OBJ's implicit material
    # rendered white in the tested headless Ogre2 pipeline.
    positions = ' '.join(str(value) for vertex in vertices for value in vertex)
    indices = ' '.join(f'0 0 {i+1} 0 {(i+1)%8+1} 0' for i in range(8))
    dae = f'''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><created>2026-11-02T00:00:00Z</created><modified>2026-11-02T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
<library_effects><effect id="red-effect"><profile_COMMON><technique sid="common"><phong>
<emission><color>0.2 0 0 1</color></emission><ambient><color>0.8 0.01 0.01 1</color></ambient>
<diffuse><color>0.9 0.01 0.01 1</color></diffuse><specular><color>0 0 0 1</color></specular>
<shininess><float>1</float></shininess></phong></technique></profile_COMMON></effect></library_effects>
<library_materials><material id="red-material" name="red"><instance_effect url="#red-effect"/></material></library_materials>
<library_geometries><geometry id="marker"><mesh>
<source id="positions"><float_array id="positions-array" count="27">{positions}</float_array><technique_common><accessor source="#positions-array" count="9" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<source id="normals"><float_array id="normals-array" count="3">0 -1 0</float_array><technique_common><accessor source="#normals-array" count="1" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices>
<triangles count="8" material="red"><input semantic="VERTEX" source="#vertices" offset="0"/><input semantic="NORMAL" source="#normals" offset="1"/><p>{indices}</p></triangles>
</mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="scene"><node id="marker-node"><instance_geometry url="#marker"><bind_material><technique_common><instance_material symbol="red" target="#red-material"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene></COLLADA>'''
    (ROOT/'marker.dae').write_text(dae)
    obstacles.append(f'''<model name="inspection_marker"><static>true</static><pose>0 3.85 0.45 0 0 0</pose>
<link name="marker"><visual name="marker"><geometry><mesh><uri>file://{ROOT/'marker.dae'}</uri></mesh></geometry>
<material><ambient>0.8 0.01 0.01 1</ambient><diffuse>0.9 0.01 0.01 1</diffuse></material></visual></link></model>''')
    robot = (ROOT / 'rover.sdf').read_text()
    robot_model = ET.tostring(ET.fromstring(robot).find('model'), encoding='unicode')
    world = f'''<?xml version="1.0"?><sdf version="1.9"><world name="warehouse">
<physics name="physics" type="ignored"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor></physics>
<plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
<plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
<plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
<plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors"><render_engine>ogre2</render_engine></plugin>
<gravity>0 0 -9.8</gravity>
<light type="directional" name="sun"><pose>0 0 10 0 0 0</pose><diffuse>1 1 1 1</diffuse><direction>-0.5 0.1 -0.9</direction></light>
<model name="ground"><static>true</static><link name="ground"><collision name="ground"><geometry><plane><normal>0 0 1</normal><size>20 20</size></plane></geometry></collision><visual name="ground_visual"><geometry><plane><normal>0 0 1</normal><size>20 20</size></plane></geometry></visual></link></model>
{''.join(obstacles)}{robot_model}</world></sdf>'''
    (ROOT / 'world.sdf').write_text(world)
    resolution, width, height = .05, 204, 164
    pixels = []
    for row in range(height):
        y = -4.1 + (height - row - .5) * resolution
        for column in range(width):
            x = -5.1 + (column + .5) * resolution
            occupied = any(abs(x-bx) <= w/2 and abs(y-by) <= d/2 for bx,by,w,d in BOXES)
            pixels.append('0' if occupied else '254')
    (ROOT / 'map.pgm').write_text(f'P2\n{width} {height}\n255\n' + '\n'.join(' '.join(pixels[i:i+width]) for i in range(0,len(pixels),width)) + '\n')

if __name__ == '__main__':
    generate()
