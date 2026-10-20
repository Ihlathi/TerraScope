# Copyright (c) 2021-2026 Littleton Robotics
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by a BSD
# license that can be found in the LICENSE file
# at the root directory of this project.

from pathlib import Path
import sqlite3
import struct

path = Path(__file__).with_name("sample.db3")
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
    db.executemany("INSERT INTO topics VALUES (?, ?, ?, ?, '')", [
        (1, "/battery", "std_msgs/msg/Float64", "cdr"),
        (2, "/robot/telemetry", "example_msgs/msg/Telemetry", "cdr"),
        (3, "/unknown", "example_msgs/msg/Unknown", "cdr"),
        (4, "/empty", "std_msgs/msg/Bool", "cdr"),
        (5, "/opaque", "example_msgs/msg/Compressed", "custom"),
    ])
    definition = """float64 speed
geometry_msgs/Vector3 position
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
"""
    db.execute("INSERT INTO message_definitions VALUES (1, ?, 'ros2msg', ?, '')", ("example_msgs/msg/Telemetry", definition))
    messages = []
    for i, voltage in enumerate([12.4, 12.1, 11.8, 12.2, 12.6]):
        timestamp = 1000000000 + i * 500000000
        messages.append((1, timestamp, b"\x00\x01\x00\x00" + struct.pack("<d", voltage)))
        messages.append((2, timestamp, b"\x00\x01\x00\x00" + struct.pack("<dddd", i * 0.75, i, i * 0.5, 0.0)))
    messages.extend([(3, 1250000000, b"\x00\x01\x00\x00\x11"), (5, 1750000000, b"opaque")])
    db.executemany("INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)", reversed(messages))
