import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "./check.mjs";

const fixture = path.join(import.meta.dirname, "check-runner-fixture.mjs");
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await pause(10);
    }
  }
  throw new Error(`fixture did not create ${file}`);
}

async function assertGone(pid, heartbeat) {
  await pause(80);
  assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
  const before = (await stat(heartbeat)).size;
  await pause(80);
  assert.equal((await stat(heartbeat)).size, before);
}

function ownedFixture(mode, directory, options = {}) {
  const pidFile = path.join(directory, `${mode}.pid`);
  const heartbeat = path.join(directory, `${mode}.heartbeat`);
  const running = runCommand(
    process.execPath,
    [fixture, mode, pidFile, heartbeat],
    { stdio: "ignore", terminationGraceMs: 100, ...options },
  );
  return { pidFile, heartbeat, running };
}

test("successful commands return and failures retain their exit status", async () => {
  await runCommand(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    }),
    /failed \(7\)/,
  );
});

test("a failed parent cannot leave its grandchild running", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "fieldwork-check-fail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { pidFile, heartbeat, running } = ownedFixture("fail", directory);
  const rejected = assert.rejects(running, /failed \(9\)/);
  const pid = await waitForFile(pidFile);
  await rejected;
  await assertGone(pid, heartbeat);
});

test("timeout escalates TERM to KILL for the entire owned process group", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "fieldwork-check-timeout-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { pidFile, heartbeat, running } = ownedFixture("hang", directory, {
    timeoutMs: 1000,
  });
  const pid = await waitForFile(pidFile);
  await assert.rejects(running, /timed out after 1000ms/);
  await assertGone(pid, heartbeat);
});

test("cancellation terminates the entire owned process group", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "fieldwork-check-cancel-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const { pidFile, heartbeat, running } = ownedFixture("hang", directory, {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  const pid = await waitForFile(pidFile);
  controller.abort();
  await assert.rejects(running, /was cancelled/);
  await assertGone(pid, heartbeat);
});

test("the complete check runs the fast tier, then the locked native tier, then the build stages", async () => {
  const source = await readFile(
    path.join(import.meta.dirname, "check.mjs"),
    "utf8",
  );
  const order = [
    'run("npm", ["test"])',
    'run("npm", ["run", "test:native"])',
    '"build"',
    '"format:check"',
    '"lint"',
    'run("bash", ["deploy/test.sh"])',
    '"verify:release"',
  ].map((needle) => source.indexOf(needle));
  assert.ok(
    order.every((index) => index >= 0),
    `missing stage in ${order}`,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.match(source, /withLock\("check"/);
  // The release fixture compiles Swift, so it shares test:native's lock.
  assert.match(source, /withLock\(\s*"native",[\s\S]*?"verify:release"/);
  assert.match(
    source,
    /cpSync\(path.join\(platform, "sample-workspace"\), root/,
  );
  assert.match(source, /"verify:release", "--", "--use-env"/);
  assert.match(source, /JOB_SEARCH_ROOT: root/);
  assert.match(source, /JOB_SEARCH_DATA: path.join\(scratch, "data"\)/);
  assert.doesNotMatch(source, /pkill/);
});

test(
  "the release stage overrides inherited workspace paths with a disposable sample",
  { skip: process.platform !== "darwin" && "Release fixture requires macOS" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "fieldwork-check-isolation-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { mkdir, writeFile, chmod, readdir } =
      await import("node:fs/promises");
    const { runChecks } = await import("./check.mjs");
    const bin = path.join(directory, "bin");
    const inheritedRoot = path.join(directory, "inherited-root");
    const inheritedData = path.join(directory, "inherited-data");
    for (const folder of [bin, inheritedRoot, inheritedData])
      await mkdir(folder);
    const trace = path.join(directory, "release.json");
    // Only the command boundary is stubbed: runChecks still owns real scratch
    // creation, sample copying, environment selection, locking and cleanup.
    const runner = `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
if (process.argv.includes("verify:release")) writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
  args: process.argv.slice(2),
  root: process.env.JOB_SEARCH_ROOT,
  data: process.env.JOB_SEARCH_DATA,
  report: process.env.JOB_SEARCH_VERIFICATION_REPORT,
  sample: existsSync(path.join(process.env.JOB_SEARCH_ROOT, "source_data", "README.md")),
}));
`;
    for (const name of ["npm", "bash"]) {
      const file = path.join(bin, name);
      await writeFile(file, runner);
      await chmod(file, 0o700);
    }
    const overrides = {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      JOB_SEARCH_ROOT: inheritedRoot,
      JOB_SEARCH_DATA: inheritedData,
      JOB_SEARCH_VERIFICATION_REPORT: path.join(inheritedRoot, "report.json"),
    };
    const saved = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, overrides);
      await runChecks();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const release = JSON.parse(await readFile(trace, "utf8"));
    assert.deepEqual(release.args, [
      "run",
      "verify:release",
      "--",
      "--use-env",
    ]);
    assert.equal(release.sample, true);
    assert.notEqual(release.root, inheritedRoot);
    assert.notEqual(release.data, inheritedData);
    assert.equal(path.dirname(release.root), path.dirname(release.data));
    assert.equal(path.dirname(release.root), path.dirname(release.report));
    assert.deepEqual(await readdir(inheritedRoot), []);
    assert.deepEqual(await readdir(inheritedData), []);
    await assert.rejects(stat(release.root), { code: "ENOENT" });
  },
);
