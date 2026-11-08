// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Server, utils } = require("ssh2");

async function createFixture({ port = 0, readDelayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terrascope-sftp-"));
  const sample = path.resolve(__dirname, "../../../sampleLogs/terrascope-sample.mcap");
  fs.copyFileSync(sample, path.join(root, "loop.mcap"));
  fs.copyFileSync(sample, path.join(root, "arm.mcap"));
  fs.writeFileSync(path.join(root, "unsupported.txt"), "Not a supported recording.\n");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem"
  });
  const status = utils.sftp.STATUS_CODE;
  const events = { connections: 0, listings: 0, reads: 0, disk: 0, removeCalls: 0 };
  const clients = new Set();
  const safePath = (remote) => {
    if (remote === "/logs") return root;
    if (!remote.startsWith("/logs/")) return null;
    const name = remote.slice(6);
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
    return path.join(root, name);
  };
  const attributes = (file) => {
    const stat = fs.statSync(file);
    return { mode: stat.mode, uid: 1000, gid: 1000, size: stat.size, atime: 1767268800, mtime: 1767268800 };
  };
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    events.connections++;
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "fixture" && context.password === "fixture-only")
        context.accept();
      else context.reject(["password"]);
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          let nextHandle = 0;
          const handles = new Map();
          const handle = (value) => {
            const id = Buffer.alloc(4);
            id.writeUInt32BE(++nextHandle);
            handles.set(nextHandle, value);
            return id;
          };
          const lookup = (id) => (id.length === 4 ? handles.get(id.readUInt32BE()) : undefined);
          sftp.on("REALPATH", (id, remote) => {
            const file = safePath(remote);
            if (!file) return sftp.status(id, status.NO_SUCH_FILE);
            sftp.name(id, [{ filename: remote, longname: remote, attrs: attributes(file) }]);
          });
          for (const operation of ["STAT", "LSTAT"])
            sftp.on(operation, (id, remote) => {
              const file = safePath(remote);
              if (!file || !fs.existsSync(file)) return sftp.status(id, status.NO_SUCH_FILE);
              sftp.attrs(id, attributes(file));
            });
          sftp.on("OPENDIR", (id, remote) => {
            if (remote !== "/logs") return sftp.status(id, status.NO_SUCH_FILE);
            events.listings++;
            sftp.handle(id, handle({ directory: true, listed: false }));
          });
          sftp.on("READDIR", (id, rawHandle) => {
            const value = lookup(rawHandle);
            if (!value?.directory) return sftp.status(id, status.FAILURE);
            if (value.listed) return sftp.status(id, status.EOF);
            value.listed = true;
            sftp.name(
              id,
              fs
                .readdirSync(root)
                .map((name) => ({ filename: name, longname: name, attrs: attributes(path.join(root, name)) }))
            );
          });
          sftp.on("OPEN", (id, remote, flags) => {
            const file = safePath(remote);
            if (flags !== utils.sftp.OPEN_MODE.READ || !file || !fs.existsSync(file) || !fs.statSync(file).isFile())
              return sftp.status(id, status.PERMISSION_DENIED);
            sftp.handle(id, handle({ bytes: fs.readFileSync(file) }));
          });
          sftp.on("READ", (id, rawHandle, offset, length) => {
            const value = lookup(rawHandle);
            if (!value?.bytes) return sftp.status(id, status.FAILURE);
            if (offset >= value.bytes.length) return sftp.status(id, status.EOF);
            events.reads++;
            const bytes = value.bytes.subarray(offset, offset + Math.min(length, 32768));
            if (readDelayMs > 0)
              setTimeout(() => {
                if (!sftp.destroyed) sftp.data(id, bytes);
              }, readDelayMs);
            else sftp.data(id, bytes);
          });
          sftp.on("CLOSE", (id, rawHandle) => {
            if (rawHandle.length === 4) handles.delete(rawHandle.readUInt32BE());
            sftp.status(id, status.OK);
          });
          for (const operation of ["REMOVE", "RMDIR", "RENAME", "WRITE", "MKDIR", "SETSTAT", "FSETSTAT", "SYMLINK"]) {
            sftp.on(operation, (id) => {
              events.removeCalls++;
              sftp.status(id, status.PERMISSION_DENIED);
            });
          }
        });
        session.on("exec", (acceptExec, rejectExec, info) => {
          if (info.command !== "LC_ALL=C xargs -0 df -Pk --") return rejectExec();
          const stream = acceptExec();
          let input = Buffer.alloc(0);
          stream.on("data", (data) => {
            input = Buffer.concat([input, data]);
          });
          stream.on("end", () => {
            if (input.toString() !== "/logs\0") {
              stream.stderr.write("Invalid fixture path.\n");
              stream.exit(1);
              return stream.end();
            }
            events.disk++;
            execFile("df", ["-Pk", "--", root], (error, stdout, stderr) => {
              stream.write(stdout);
              if (stderr) stream.stderr.write(stderr);
              stream.exit(error ? 1 : 0);
              stream.end();
            });
          });
        });
      })
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    root,
    events,
    async close() {
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
      assert.equal(events.removeCalls, 0, "No remote writes or removal APIs were called");
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
module.exports = { createFixture };
