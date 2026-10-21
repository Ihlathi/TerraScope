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
        data = value.encode() + b"\x00"
        self.number("I", len(data))
        self.data.extend(data)

    def header(self, second):
        self.number("i", second)
        self.number("I", 0)
        self.string("sensor")


header_definition = """================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""
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
""" + header_definition
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
""" + header_definition

path = Path(__file__).with_name("spatial-sensors.db3")
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
    for topic_id, name, kind, definition in [
        (1, "/scan", "LaserScan", scan_definition),
        (2, "/cloud", "PointCloud2", cloud_definition),
    ]:
        type_name = "sensor_msgs/msg/" + kind
        db.execute("INSERT INTO topics VALUES (?, ?, ?, 'cdr', '')", (topic_id, name, type_name))
        db.execute("INSERT INTO message_definitions VALUES (?, ?, 'ros2msg', ?, '')", (topic_id, type_name, definition))
    for second in [1, 2, 3]:
        scan = CDR()
        scan.header(second)
        for value in [0, 2 * math.pi, 2 * math.pi / 180, 0, 1, 0.1, 20]:
            scan.number("f", value)
        count = 181 if second < 3 else 0
        scan.number("I", count)
        for i in range(count):
            scan.number("f", 3 + 0.3 * (second - 1) + 0.4 * math.sin(i * math.pi / 45))
        scan.number("I", 0)
        db.execute("INSERT INTO messages (topic_id, timestamp, data) VALUES (1, ?, ?)", (second * 1000000000, scan.data))

        cloud = CDR()
        cloud.header(second)
        cloud.number("I", 1)
        count = 441 if second < 3 else 0
        cloud.number("I", count)
        cloud.number("I", 3)
        for offset, name in enumerate(["x", "y", "z"]):
            cloud.string(name)
            cloud.number("I", offset * 4)
            cloud.number("B", 7)
            cloud.number("I", 1)
        cloud.number("B", 0)
        cloud.number("I", 12)
        cloud.number("I", count * 12)
        cloud.number("I", count * 12)
        for i in range(count):
            x = 1.5 + 0.5 * (second - 1) + 0.3 * math.cos((i % 21) * math.pi / 10)
            y = -2 + (i % 21) * 0.2
            z = 0.25 + (i // 21) * 0.125
            cloud.data.extend(struct.pack("<fff", x, y, z))
        cloud.number("B", 1)
        db.execute("INSERT INTO messages (topic_id, timestamp, data) VALUES (2, ?, ?)", (second * 1000000000, cloud.data))
