import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { CodexControllerLock } from "../server/codex-controller-lock.js";
import {
  parseProcessIdentity,
  type ControllerProcess,
} from "../server/controller-process.js";

const identity = (startedAt: string, uid = 501): ControllerProcess => ({
  state: "alive",
  identity: { startedAt, uid },
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
  const file = path.join(dir, "codex-controller.lock");
  const processes = new Map<number, ControllerProcess>([
    [10, identity("2026-10-11T00:00:00.000Z")],
    [20, identity("2026-10-11T01:00:00.000Z")],
  ]);
  const create = (pid: number) =>
    new CodexControllerLock(dir, {
      pid,
      inspect: (id) => processes.get(id) ?? { state: "dead" },
    });
  return {
    dir,
    file,
    processes,
    create,
    owner: () => JSON.parse(readFileSync(file, "utf8")),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("process identity parser uses UTC start time and numeric UID, rejects malformed output", () => {
  assert.deepEqual(parseProcessIdentity("Sat Oct 10 23:40:44 2026   248\n"), {
    startedAt: "2026-10-10T23:40:44.000Z",
    uid: 248,
  });
  assert.equal(parseProcessIdentity(""), undefined);
  assert.equal(parseProcessIdentity("Sat Feb 30 23:40:44 2026 248"), undefined);
  assert.equal(parseProcessIdentity("Sat Oct 10 25:40:44 2026 248"), undefined);
});
test("live controller retains ownership; release only removes its own token", () => {
  const f = fixture();
  try {
    const first = f.create(10),
      second = f.create(20);
    first.acquire();
    assert.equal(first.owned, true);
    assert.equal(f.owner().version, 2);
    assert.deepEqual(f.owner().identity, {
      startedAt: "2026-10-11T00:00:00.000Z",
      uid: 501,
    });
    assert.throws(
      () => second.acquire(),
      /Another application process controls/,
    );
    second.release();
    assert.equal(f.owner().pid, 10);
    first.release();
    assert.equal(existsSync(f.file), false);
    second.acquire();
    assert.equal(f.owner().pid, 20);
    second.release();
  } finally {
    f.close();
  }
});
test("PID reuse is distinguished from the original live process", () => {
  const f = fixture();
  try {
    const old = f.create(10);
    old.acquire();
    f.processes.set(10, identity("2026-10-12T00:00:00.000Z", 248));
    const replacement = f.create(20);
    replacement.acquire();
    assert.equal(f.owner().pid, 20);
    old.release();
    assert.equal(
      f.owner().pid,
      20,
      "old shutdown cannot unlink the replacement",
    );
    replacement.release();
  } finally {
    f.close();
  }
});
test("legacy lock whose PID now belongs to a later-born process is reclaimed", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ pid: 575, token: "legacy" }));
    utimesSync(
      f.file,
      new Date("2026-10-09T21:14:09Z"),
      new Date("2026-10-09T21:14:09Z"),
    );
    f.processes.set(575, identity("2026-10-10T23:40:44.000Z", 248));
    const current = f.create(20);
    current.acquire();
    assert.equal(f.owner().pid, 20);
    current.release();
    assert.equal(readdirSync(f.dir).length, 0, "reclaim marker cleaned up");
  } finally {
    f.close();
  }
});
test("unverifiable or same-age legacy owners are never cleared", () => {
  const f = fixture();
  try {
    const content = JSON.stringify({ pid: 575, token: "legacy" });
    writeFileSync(f.file, content);
    f.processes.set(575, { state: "unknown", reason: "EPERM" });
    assert.throws(
      () => f.create(20).acquire(),
      /Cannot verify ownership.*575.*EPERM/,
    );
    assert.equal(readFileSync(f.file, "utf8"), content);
    f.processes.set(575, { state: "alive" });
    assert.throws(() => f.create(20).acquire(), /Another application process/);
    f.processes.set(575, identity("2020-01-01T00:00:00.000Z"));
    assert.throws(() => f.create(20).acquire(), /Another application process/);
    assert.equal(readFileSync(f.file, "utf8"), content);
  } finally {
    f.close();
  }
});
test("dead controllers recover and malformed locks remain for inspection", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ pid: 99, token: "dead" }));
    const current = f.create(20);
    current.acquire();
    assert.equal(f.owner().pid, 20);
    current.release();
    for (const content of [
      '{"token":"secret',
      JSON.stringify({ pid: -1, token: "invalid" }),
      JSON.stringify({
        pid: 99,
        token: "invalid",
        identity: { uid: 501, startedAt: "invalid" },
      }),
    ]) {
      writeFileSync(f.file, content);
      assert.throws(() => f.create(20).acquire(), /lock is invalid/);
      assert.equal(readFileSync(f.file, "utf8"), content);
    }
  } finally {
    f.close();
  }
});
test("reclaim rechecks the lock after election instead of deleting a new owner", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ pid: 99, token: "stale" }));
    let staleSeen = false;
    const current = new CodexControllerLock(f.dir, {
      pid: 20,
      inspect: (pid) => {
        if (pid === 99) {
          staleSeen = true;
          return { state: "dead" };
        }
        if (staleSeen && pid === 20) {
          writeFileSync(
            f.file,
            JSON.stringify({ pid: 10, token: "new-owner" }),
          );
          staleSeen = false;
        }
        return f.processes.get(pid) ?? { state: "dead" };
      },
    });
    assert.throws(() => current.acquire(), /Another application process/);
    assert.equal(f.owner().token, "new-owner");
  } finally {
    f.close();
  }
});
