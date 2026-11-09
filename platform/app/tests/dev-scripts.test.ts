import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimServerFile,
  defaultSandboxName,
  releaseServerFile,
  sandboxEnv,
  sandboxLayout,
  freeLoopbackPort,
  parseDevClientArgs,
  parseDevServerArgs,
} from "../scripts/dev-options.js";

test("dev:client defaults to the companion and accepts --api", () => {
  assert.deepEqual(parseDevClientArgs([]), { api: 4317 });
  assert.deepEqual(parseDevClientArgs(["--api", "5001"]), { api: 5001 });
});

test("dev:server names each plain run uniquely from the branch", () => {
  assert.match(
    defaultSandboxName("feature/My Branch!", "ab12"),
    /^feature-my-branch-ab12$/,
  );
  assert.equal(defaultSandboxName("", "ab12"), "dev-ab12");
  const a = parseDevServerArgs([]);
  const b = parseDevServerArgs([]);
  assert.notEqual(a.name, b.name);
  assert.equal(a.port, undefined);
  assert.deepEqual(parseDevServerArgs(["--name", "a-1", "--port", "4400"]), {
    name: "a-1",
    port: 4400,
  });
});

test("dev scripts reject typos, bad ports and path-like names", () => {
  assert.throws(() => parseDevClientArgs(["--apii", "5001"]), /Unknown/);
  assert.throws(() => parseDevClientArgs(["--api"]), /needs a value/);
  assert.throws(() => parseDevClientArgs(["--api", "80"]), /between/);
  assert.throws(
    () => parseDevServerArgs(["--name", "../job-search"]),
    /--name/,
  );
});

test("dev:server rejects the companion port", () => {
  assert.throws(() => parseDevServerArgs(["--port", "4317"]), /companion/);
});

test("server.json blocks a second backend on a live pid and is reusable once released", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dev-claim-"));
  const file = path.join(dir, "server.json");
  try {
    claimServerFile(file, process.pid, 4400);
    const recorded = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(recorded.pid, process.pid);
    assert.equal(recorded.port, 4400);
    assert.ok(recorded.startedAt);
    assert.throws(() => claimServerFile(file, 1, 4401), /already running/);
    releaseServerFile(file);
    claimServerFile(file, process.pid, 4402);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sandbox child gets source root and data under the sandbox only", () => {
  const checkout = "/real/checkout";
  const layout = sandboxLayout(checkout, "t-1");
  const env = sandboxEnv(
    {
      JOB_SEARCH_ROOT: checkout,
      JOB_SEARCH_DATA: `${checkout}/.local/job-search`,
      KEEP: "1",
    },
    layout,
    4400,
  );
  const inside = (p?: string) =>
    path.relative(layout.home, p ?? "") !== "" &&
    !path.relative(layout.home, p ?? "").startsWith("..");
  assert.ok(inside(env.JOB_SEARCH_ROOT));
  assert.ok(inside(env.JOB_SEARCH_DATA));
  for (const value of [env.JOB_SEARCH_ROOT, env.JOB_SEARCH_DATA])
    assert.ok(value!.startsWith(`${checkout}/.local/dev/t-1/`));
  assert.equal(env.KEEP, "1");
});

test("paths the server derives from the sandbox env stay in the sandbox", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dev-paths-"));
  try {
    const layout = sandboxLayout(dir, "t-2");
    const env = sandboxEnv(process.env, layout, 4400);
    const script = `
      import path from "node:path";
      const p = await import("./app/server/paths.ts");
      console.log(JSON.stringify({
        root: p.repositoryRoot,
        data: p.dataDirectory,
        sources: path.join(p.repositoryRoot, "company_careers"),
      }));`;
    const out = spawnSync(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      ["--input-type=module", "-e", script],
      {
        env,
        encoding: "utf8",
        cwd: path.resolve(import.meta.dirname, "../.."),
      },
    );
    assert.equal(out.status, 0, out.stderr);
    const derived = JSON.parse(out.stdout.trim().split("\n").pop()!);
    for (const value of Object.values(derived) as string[])
      assert.ok(value.startsWith(`${layout.home}${path.sep}`), value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freeLoopbackPort returns a bindable port", async () => {
  assert.ok((await freeLoopbackPort()) >= 1024);
});
