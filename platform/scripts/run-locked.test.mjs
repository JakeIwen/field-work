import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(import.meta.dirname, "run-locked.mjs");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "fieldwork-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, name, command, args, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [script, name, "--", command, ...args],
    {
      env: {
        ...process.env,
        FIELDWORK_LOCK_ROOT: root,
        FIELDWORK_LOCK_POLL_MS: "30",
        FIELDWORK_LOCK_NOTICE_MS: "50",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise((resolve) =>
    child.once("close", (code) => resolve({ code, out })),
  );
  return { child, done };
}

const node = (code) => [process.execPath, ["-e", code]];

test("two concurrent runs serialize", async (t) => {
  const root = sandbox(t);
  const log = path.join(root, "log");
  const body = (tag) =>
    `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"${tag}+\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},"${tag}-\\n")},300)`;
  const first = run(root, "t", ...node(body("a")));
  await new Promise((r) => setTimeout(r, 100));
  const second = run(root, "t", ...node(body("b")));
  const [one, two] = await Promise.all([first.done, second.done]);
  assert.equal(one.code, 0);
  assert.equal(two.code, 0);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "a+",
    "a-",
    "b+",
    "b-",
  ]);
  assert.match(two.out, /waiting for t lock held by pid \d+ since \d\d:\d\d/);
  assert.match(one.out, /t pid \d+/);
});

test("a stale lock is reclaimed", async (t) => {
  const root = sandbox(t);
  const dir = path.join(root, "t");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "owner.json"),
    JSON.stringify({
      pid: 2 ** 22 + 12345,
      started: new Date().toISOString(),
      argv: [],
      cwd: "/",
    }),
  );
  const { done } = run(root, "t", ...node("0"));
  const result = await done;
  assert.equal(result.code, 0);
  assert.match(result.out, /stale t lock .* reclaimed/);
});

test("the lock is released after a failing command and the exit code passes through", async (t) => {
  const root = sandbox(t);
  const result = await run(root, "t", ...node("process.exit(7)")).done;
  assert.equal(result.code, 7);
  assert.equal(existsSync(path.join(root, "t")), false);
});

test("SIGTERM reaches the command's group and releases the lock", async (t) => {
  const root = sandbox(t);
  const { child, done } = run(root, "t", ...node("setInterval(()=>{},1000)"));
  while (!existsSync(path.join(root, "t", "owner.json")))
    await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  child.kill("SIGTERM");
  const result = await done;
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(path.join(root, "t")), false);
});

const deadPid = 2 ** 22 + 12345;

function abandon(root, name, owner = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "owner.json"),
    JSON.stringify({
      pid: deadPid,
      token: "dead-owner",
      started: new Date().toISOString(),
      argv: [],
      cwd: "/",
      ...owner,
    }),
  );
}

test("many contenders behind a dead owner run one at a time and all run", async (t) => {
  const root = sandbox(t);
  abandon(root, "t");
  const log = path.join(root, "holders.log");
  const count = 12;
  // O_APPEND writes are atomic, so the log order is the real order: a second
  // holder starting before the first finishes shows up as "+x +y".
  const body = (id) =>
    `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"+${id}\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},"-${id}\\n")},40)`;
  const contenders = Array.from({ length: count }, (_, id) =>
    run(root, "t", ...node(body(id))),
  );
  const results = await Promise.all(contenders.map((c) => c.done));
  assert.deepEqual(
    results.map((r) => r.code),
    Array(count).fill(0),
    results.map((r) => r.out).join("\n"),
  );
  const events = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(events.length, count * 2);
  for (let i = 0; i < events.length; i += 2) {
    assert.match(events[i], /^\+\d+$/);
    assert.equal(events[i + 1], `-${events[i].slice(1)}`, events.join(" "));
  }
  assert.equal(new Set(events.map((e) => e.slice(1))).size, count);
  assert.equal(existsSync(path.join(root, "t")), false);
  assert.equal(existsSync(path.join(root, "t.recover")), false);
  const reclaims = results.filter((r) => /stale t lock/.test(r.out)).length;
  assert.equal(reclaims, 1, "exactly one contender reclaims the dead lock");
});

test("an ownerless lock is left alone while fresh and reclaimed once abandoned", async (t) => {
  const root = sandbox(t);
  mkdirSync(path.join(root, "t"));
  const early = run(root, "t", ...node("0"), { FIELDWORK_LOCK_FLUX_MS: "700" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(path.join(root, "t")), true, "still in flux");
  const result = await early.done;
  assert.equal(result.code, 0);
  assert.match(result.out, /stale t lock \(no owner\) reclaimed/);
});

test("an unparsable owner file is in flux, never an error", async (t) => {
  const root = sandbox(t);
  mkdirSync(path.join(root, "t"));
  writeFileSync(path.join(root, "t", "owner.json"), "{ not json");
  const result = await run(root, "t", ...node("0"), {
    FIELDWORK_LOCK_FLUX_MS: "300",
  }).done;
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /reclaimed/);
});

test("release leaves a lock whose owner token is not ours", async (t) => {
  const root = sandbox(t);
  const dir = path.join(root, "t");
  // The command replaces the lock's owner, as a reclaimer that mistook us for
  // dead would; our release must not remove the other holder's lock.
  const body = `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "owner.json"))},JSON.stringify({pid:process.pid,token:"someone-else",started:new Date().toISOString(),argv:[]}))`;
  const result = await run(root, "t", ...node(body)).done;
  assert.equal(result.code, 0);
  assert.equal(existsSync(path.join(dir, "owner.json")), true);
});

test("the lock is held until the command's whole process group is gone", async (t) => {
  const root = sandbox(t);
  const fixture = path.join(import.meta.dirname, "check-runner-fixture.mjs");
  const pidFile = path.join(root, "grandchild.pid");
  const heartbeat = path.join(root, "grandchild.heartbeat");
  const env = { FIELDWORK_LOCK_GRACE_MS: "150" };
  // The fixture's parent exits 9 once its TERM-ignoring grandchild is running.
  const first = run(
    root,
    "t",
    process.execPath,
    [fixture, "fail", pidFile, heartbeat],
    env,
  );
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 10));
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  // Queued behind it: succeeds only if the grandchild is already dead when the
  // lock is handed over.
  const second = run(
    root,
    "t",
    ...node(
      `try{process.kill(${grandchild},0);process.exit(1)}catch{process.exit(0)}`,
    ),
  );
  const [one, two] = await Promise.all([first.done, second.done]);
  assert.equal(one.code, 9);
  assert.equal(two.code, 0, "grandchild outlived the lock");
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
});

test("--path and --describe report the lock without taking it", async (t) => {
  const root = sandbox(t);
  const env = { ...process.env, FIELDWORK_LOCK_ROOT: root };
  const ask = (flag) =>
    spawnSync(process.execPath, [script, flag, "t"], {
      env,
      encoding: "utf8",
    }).stdout.trim();
  assert.equal(ask("--path"), path.join(root, "t"));
  assert.equal(ask("--describe"), "free");
  abandon(root, "t");
  assert.match(ask("--describe"), /dead or unreadable owner/);
  abandon(root, "t", { pid: process.pid, argv: ["bash", "x"] });
  assert.match(
    ask("--describe"),
    new RegExp(
      `held by pid ${process.pid} since \\d\\d:\\d\\d \\(bash x\\); a real run would wait`,
    ),
  );
});
