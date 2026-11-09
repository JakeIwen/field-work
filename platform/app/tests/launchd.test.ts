import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  serviceLabel,
  serviceDomain,
  serviceDestination,
  serviceProperties,
  servicePlist,
  type ServiceConfig,
} from "../server/launchd.js";

const config: ServiceConfig = {
  label: serviceLabel,
  scope: "boot",
  uid: 501,
  username: "sampleuser",
  home: "/Users/sampleuser",
  node: "/Users/sampleuser/.nvm/versions/node/v22.22.0/bin/node",
  loader: "/repo/platform/node_modules/tsx/dist/loader.mjs",
  platform: "/repo/platform",
  root: "/repo",
  data: "/repo/.local/job-search",
  port: 4317,
};
test("boot job runs as the owning user with persistent supervision and explicit runtime paths", () => {
  const p = serviceProperties(config) as any;
  assert.equal(p.UserName, "sampleuser");
  assert.equal(serviceDomain(config), "system");
  assert.equal(
    serviceDestination(config),
    "/Library/LaunchDaemons/local.fieldwork.plist",
  );
  assert.deepEqual(p.ProgramArguments, [
    config.node,
    "--import",
    config.loader,
    "/repo/platform/app/server/index.ts",
  ]);
  assert.equal(p.RunAtLoad, true);
  assert.equal(p.KeepAlive, true);
  assert.equal(p.ThrottleInterval, 10);
  assert.equal(p.Umask, 63);
  assert.equal(p.EnvironmentVariables.JOB_SEARCH_DATA, config.data);
  assert.equal(p.EnvironmentVariables.HOME, config.home);
  assert.ok(
    p.EnvironmentVariables.PATH.includes("/Users/sampleuser/.local/bin"),
  );
  assert.equal("OPENAI_API_KEY" in p.EnvironmentVariables, false);
  assert.equal("CODEX_API_KEY" in p.EnvironmentVariables, false);
});
test("login option uses user launchd domain and no root service identity", () => {
  const c = { ...config, scope: "login" as const };
  assert.equal(serviceDomain(c), "gui/501");
  assert.equal(
    serviceDestination(c),
    "/Users/sampleuser/Library/LaunchAgents/local.fieldwork.plist",
  );
  assert.equal("UserName" in serviceProperties(c), false);
});
test("service configuration rejects root execution and malformed identities or paths", () => {
  for (const patch of [
    { uid: 0 },
    { username: "root" },
    { label: "com.other.service" },
    { port: 80 },
    { platform: "relative" },
    { data: "/repo\n/injected" },
  ])
    assert.throws(() => servicePlist({ ...config, ...patch }));
});
test(
  "actual macOS plist parser preserves spaces and XML metacharacters without creating extra arguments",
  { skip: process.platform !== "darwin" },
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fieldwork-launchd-"));
    try {
      const c = {
        ...config,
        platform: "/repo/Sam & team <private>",
        data: '/repo/a "quote" & b',
      };
      const plist = path.join(dir, "service.plist");
      writeFileSync(plist, servicePlist(c));
      execFileSync("/usr/bin/plutil", ["-lint", plist]);
      const decoded = JSON.parse(
        execFileSync(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", plist],
          { encoding: "utf8" },
        ),
      );
      assert.deepEqual(decoded, serviceProperties(c));
      assert.ok(Array.isArray(decoded.ProgramArguments));
      assert.equal(decoded.ProgramArguments.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
