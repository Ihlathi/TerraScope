# Copyright (c) 2021-2026 Littleton Robotics
# http://github.com/Mechanical-Advantage
#
# Use of this source code is governed by a BSD
# license that can be found in the LICENSE file
# at the root directory of this project.

from io import BytesIO
from pathlib import Path
import sqlite3
import struct
from PIL import Image


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

    def bytes(self, value):
        self.number("I", len(value))
        self.data.extend(value)

    def header(self, second, nanosecond):
        self.number("i", second)
        self.number("I", nanosecond)
        self.string("camera")


header = """================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
"""
raw = """std_msgs/Header header
uint32 height
uint32 width
string encoding
uint8 is_bigendian
uint32 step
uint8[] data
""" + header
compressed = """std_msgs/Header header
string format
uint8[] data
""" + header

path = Path(__file__).with_name("images.db3")
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
    for index, encoding in enumerate(["rgb8", "bgr8", "mono8", "jpeg", "png"]):
        kind = "Image" if index < 3 else "CompressedImage"
        type_name = "sensor_msgs/msg/" + kind
        topic_id = index + 1
        db.execute("INSERT INTO topics VALUES (?, ?, ?, 'cdr', '')", (topic_id, "/camera/" + encoding, type_name))
        if index in [0, 3]:
            db.execute("INSERT INTO message_definitions VALUES (?, ?, 'ros2msg', ?, '')", (topic_id, type_name, raw if index == 0 else compressed))
        for second in [1, 2, 3]:
            nanosecond = index * 100_000_000
            message = CDR()
            message.header(second, nanosecond)
            pixels = [(10 + second, 40 + second, 90 + second), (110 + second, 140 + second, 190 + second),
                      (20 + second, 50 + second, 100 + second), (120 + second, 150 + second, 200 + second)]
            if index < 3:
                channels = 1 if encoding == "mono8" else 3
                step = 2 * channels + 3
                data = bytearray()
                for row in range(2):
                    for red, green, blue in pixels[row * 2:row * 2 + 2]:
                        data.extend([red] if channels == 1 else [blue, green, red] if encoding == "bgr8" else [red, green, blue])
                    data.extend([241, 242, 243])
                message.number("I", 2)
                message.number("I", 2)
                message.string(encoding)
                message.number("B", 0)
                message.number("I", step)
                message.bytes(data)
            else:
                image = Image.new("RGB", (2, 2))
                image.putdata(pixels)
                output = BytesIO()
                if encoding == "jpeg":
                    image.save(output, format="JPEG", quality=100, subsampling=0)
                    message.string("rgb8; jpeg compressed bgr8")
                else:
                    image.save(output, format="PNG", compress_level=9)
                    message.string("rgb8; png compressed rgb8")
                message.bytes(output.getvalue())
            timestamp = second * 1_000_000_000 + nanosecond
            db.execute("INSERT INTO messages (topic_id, timestamp, data) VALUES (?, ?, ?)", (topic_id, timestamp, message.data))
