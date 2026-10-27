# Copyright (c) 2021-2026 Littleton Robotics
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by a BSD
# license that can be found in the LICENSE file
# at the root directory of this project.

from pathlib import Path
import math
import sqlite3
import struct

ROOT = Path(__file__).resolve().parents[1] / "src/hub/dataSources/ros2/fixtures/urdf"
URDF = '''<?xml version="1.0"?>
<robot name="TerraScope fixture">
  <material name="blue"><color rgba="0.1 0.35 0.85 1"/></material>
  <material name="orange"><color rgba="0.95 0.4 0.05 1"/></material>
  <link name="base_link">
    <visual><origin xyz="0 0 0.15"/><geometry><box size="0.9 0.7 0.3"/></geometry><material name="blue"/></visual>
  </link>
  <link name="arm_link">
    <visual><origin xyz="0.6 0 0" rpy="0 1.5707963267948966 0"/><geometry><cylinder radius="0.09" length="1.2"/></geometry><material name="orange"/></visual>
    <visual><geometry><sphere radius="0.16"/></geometry><material name="blue"/></visual>
  </link>
  <link name="carriage_link">
    <visual><geometry><mesh filename="meshes/carriage.stl" scale="0.3 0.3 0.3"/></geometry><material name="blue"/></visual>
  </link>
  <link name="tool_link">
    <visual><geometry><mesh filename="package://demo/meshes/tool.dae" scale="0.3 0.3 0.3"/></geometry><material name="orange"/></visual>
  </link>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="arm_link"/><origin xyz="0 0 0.5"/>
    <axis xyz="0 0 1"/><limit lower="-1.2" upper="1.2" effort="10" velocity="2"/>
  </joint>
  <joint name="slider" type="prismatic">
    <parent link="arm_link"/><child link="carriage_link"/><origin xyz="1.2 0 0"/>
    <axis xyz="1 0 0"/><limit lower="0" upper="0.8" effort="10" velocity="1"/>
  </joint>
  <joint name="fixed_tool" type="fixed">
    <parent link="carriage_link"/><child link="tool_link"/><origin xyz="0.2 0 0.2" rpy="0 0 0.2"/>
  </joint>
</robot>
'''
DAE = '''<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><author>TerraScope contributors</author></contributor><created>2026-10-25T00:00:00Z</created><modified>2026-10-25T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
  <library_geometries><geometry id="tool"><mesh>
    <source id="positions"><float_array id="positions-array" count="12">0 0 0 1 0 0 0 1 0 0 0 1</float_array><technique_common><accessor source="#positions-array" count="4" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices>
    <triangles count="4"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 2 1 0 1 3 0 3 2 1 2 3</p></triangles>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="Scene"><node id="tool-node"><instance_geometry url="#tool"/></node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
'''


class CDR:
    def __init__(self):
        self.data = bytearray(b"\x00\x01\x00\x00")

    def number(self, fmt, value):
        self.data.extend(b"\x00" * ((4 - len(self.data)) % struct.calcsize(fmt)))
        self.data.extend(struct.pack("<" + fmt, value))

    def string(self, value):
        value = value.encode() + b"\x00"
        self.number("I", len(value))
        self.data.extend(value)

    def header(self, time, frame):
        self.number("i", time)
        self.number("I", 0)
        self.string(frame)

    def numbers(self, values):
        self.number("I", len(values))
        for value in values:
            self.number("d", value)


def joints(time, names, positions):
    result = CDR()
    result.header(time, "base_link")
    result.number("I", len(names))
    for name in names:
        result.string(name)
    result.numbers(positions)
    result.numbers([])
    result.numbers([])
    return result.data


def static_tf():
    result = CDR()
    result.number("I", 1)
    result.header(1, "map")
    result.string("base_link")
    for value in [0, 0, 0, 0, 0, 0, 1]:
        result.number("d", value)
    return result.data


def scan():
    result = CDR()
    result.header(1, "tool_link")
    for value in [-math.pi / 4, math.pi / 4, math.pi / 16, 0, 1, 0.1, 10]:
        result.number("f", value)
    result.number("I", 9)
    for _ in range(9):
        result.number("f", 0.6)
    result.number("I", 0)
    return result.data


def main():
    (ROOT / "meshes").mkdir(parents=True, exist_ok=True)
    (ROOT / "packages/demo/meshes").mkdir(parents=True, exist_ok=True)
    (ROOT / "robot.urdf").write_text(URDF)
    (ROOT / "packages/demo/meshes/tool.dae").write_text(DAE)
    vertices = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
    facets = []
    for face in [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]:
        points = "\n".join("      vertex " + " ".join(map(str, vertices[index])) for index in face)
        a, b, c = [vertices[index] for index in face]
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        length = math.sqrt(sum(value * value for value in normal))
        normal = " ".join(str(value / length) for value in normal)
        facets.append(f"  facet normal {normal}\n    outer loop\n{points}\n    endloop\n  endfacet")
    (ROOT / "meshes/carriage.stl").write_text("solid carriage\n" + "\n".join(facets) + "\nendsolid carriage\n")
    target = ROOT / "robot.db3"
    target.unlink(missing_ok=True)
    with sqlite3.connect(target) as db:
        db.executescript('''
            CREATE TABLE schema (schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
            INSERT INTO schema VALUES (4, 'humble');
            CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
                serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
            CREATE INDEX timestamp_idx ON messages (timestamp ASC);
        ''')
        for topic_id, name, kind in [
            (1, "/robot_description", "std_msgs/msg/String"),
            (2, "/joint_states", "sensor_msgs/msg/JointState"),
            (3, "/tf_static", "tf2_msgs/msg/TFMessage"),
            (4, "/scan", "sensor_msgs/msg/LaserScan"),
        ]:
            db.execute("INSERT INTO topics VALUES (?, ?, ?, 'cdr', '')", (topic_id, name, kind))
        description = CDR()
        description.string(URDF)
        for topic_id, time, payload in [
            (1, 1, description.data),
            (2, 1, joints(1, ["shoulder", "slider"], [0, 0])),
            (2, 2, joints(2, ["slider", "shoulder"], [0.7, 1.0])),
            (2, 3, joints(3, ["shoulder", "slider"], [2.0, -0.5])),
            (3, 1, static_tf()),
            (4, 1, scan()),
        ]:
            db.execute("INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)",
                       (topic_id, time * 1_000_000_000, payload))
    print(f"Generated {target.relative_to(Path(__file__).resolve().parents[1])} and URDF meshes")


if __name__ == "__main__":
    main()
