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


class CDR:
    def __init__(self):
        self.data = bytearray(b"\x00\x01\x00\x00")

    def number(self, fmt, value):
        alignment = struct.calcsize(fmt)
        self.data.extend(b"\x00" * ((4 - len(self.data)) % alignment))
        self.data.extend(struct.pack("<" + fmt, value))

    def string(self, value):
        value = value.encode() + b"\x00"
        self.number("I", len(value))
        self.data.extend(value)

    def header(self, time, frame):
        self.number("i", time)
        self.number("I", 0)
        self.string(frame)


def transform_message(time, edges):
    message = CDR()
    message.number("I", len(edges))
    for parent, child, xyz, yaw in edges:
        message.header(time, parent)
        message.string(child)
        for value in [*xyz, 0, 0, math.sin(yaw / 2), math.cos(yaw / 2)]:
            message.number("d", value)
    return message.data


def scan_message(frame):
    message = CDR()
    message.header(1, frame)
    for value in [0, math.pi, math.pi / 90, 0, 1, 0.1, 20]:
        message.number("f", value)
    message.number("I", 91)
    for i in range(91):
        message.number("f", 1.5 + 0.2 * math.sin(i * math.pi / 15))
    message.number("I", 0)
    return message.data


def cloud_message():
    message = CDR()
    message.header(1, "laser")
    message.number("I", 1)
    message.number("I", 3)
    message.number("I", 3)
    for i, name in enumerate(["x", "y", "z"]):
        message.string(name)
        message.number("I", i * 4)
        message.number("B", 7)
        message.number("I", 1)
    message.number("B", 0)
    message.number("I", 12)
    message.number("I", 36)
    message.number("I", 36)
    for point in [(0, 0, 0.3), (0.5, 0, 0.3), (0, 0.5, 0.3)]:
        message.data.extend(struct.pack("<fff", *point))
    message.number("B", 1)
    return message.data


header = """================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""
tf_definition = """geometry_msgs/TransformStamped[] transforms
================================================================================
MSG: geometry_msgs/TransformStamped
std_msgs/Header header
string child_frame_id
geometry_msgs/Transform transform
================================================================================
MSG: geometry_msgs/Transform
geometry_msgs/Vector3 translation
geometry_msgs/Quaternion rotation
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
================================================================================
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w
""" + header
scan_definition = """std_msgs/Header header
float32 angle_min
float32 angle_max
float32 angle_increment
float32 time_increment
float32 scan_time
float32 range_min
float32 range_max
float32[] ranges
float32[] intensities
""" + header
cloud_definition = """std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense
================================================================================
MSG: sensor_msgs/PointField
string name
uint32 offset
uint8 datatype
uint32 count
""" + header

path = Path(__file__).with_name("transform-tree.db3")
if path.exists():
    path.unlink()
with sqlite3.connect(path) as db:
    db.executescript("""
        CREATE TABLE schema (schema_version INTEGER PRIMARY KEY, ros_distro TEXT NOT NULL);
        INSERT INTO schema VALUES (4, 'humble');
        CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
            serialization_format TEXT NOT NULL, offered_qos_profiles TEXT NOT NULL);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, data BLOB NOT NULL);
        CREATE INDEX timestamp_idx ON messages (timestamp ASC);
        CREATE TABLE message_definitions (id INTEGER PRIMARY KEY, topic_type TEXT NOT NULL, encoding TEXT NOT NULL,
            encoded_message_definition TEXT NOT NULL, type_description_hash TEXT NOT NULL);
    """)
    for topic_id, name, kind in [
        (1, "/tf_static", "tf2_msgs/msg/TFMessage"),
        (2, "/tf", "tf2_msgs/msg/TFMessage"),
        (3, "/scan", "sensor_msgs/msg/LaserScan"),
        (4, "/orphan_scan", "sensor_msgs/msg/LaserScan"),
        (5, "/cloud", "sensor_msgs/msg/PointCloud2"),
    ]:
        db.execute("INSERT INTO topics VALUES (?, ?, ?, 'cdr', '')", (topic_id, name, kind))
    for kind, definition in [
        ("tf2_msgs/msg/TFMessage", tf_definition),
        ("sensor_msgs/msg/LaserScan", scan_definition),
        ("sensor_msgs/msg/PointCloud2", cloud_definition),
    ]:
        db.execute("INSERT INTO message_definitions (topic_type, encoding, encoded_message_definition, type_description_hash) VALUES (?, 'ros2msg', ?, '')", (kind, definition))
    for topic_id, time, payload in [
        (1, 1, transform_message(1, [("base", "laser", (0.5, 0, 0.25), 0), ("missing_mount", "orphan_sensor", (0, 0, 0), 0)])),
        (2, 1, transform_message(1, [("map", "base", (-2, -1, 0), 0)])),
        (2, 2, transform_message(2, [("map", "base", (2, 1, 0), math.pi / 2)])),
        (3, 1, scan_message("laser")),
        (4, 1, scan_message("orphan_sensor")),
        (5, 1, cloud_message()),
        (2, 3, transform_message(3, [("map", "base", (2, 1, 0), math.pi / 2)])),
    ]:
        db.execute("INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)", (topic_id, time * 1000000000, payload))
