import assert from "node:assert/strict";
import { paletteSaveProblem, themeSaveProblem } from "../shared/palette.js";
import { demoTheme } from "../scripts/demo-seed.js";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import { JSDOM } from "jsdom";
import { demoNavigationGuard } from "../scripts/demo-shell.js";
import test from "node:test";
import { demoAddressAllowed } from "../scripts/demo-network.js";
import { startDemo } from "../scripts/demo-runtime.js";

test("demo is synthetic, read-only, integration-free and refuses companion/non-loopback sockets", async () => {
  assert.equal(demoAddressAllowed("127.0.0.1", 4317), false);
  assert.equal(demoAddressAllowed("example.org", 443), false);
  assert.equal(demoAddressAllowed("127.0.0.1", 5000), false);
  await assert.rejects(startDemo(["--port", "4317"]), /companion/);
  assert.equal(demoAddressAllowed("127.0.0.1", 44317, [44317]), false);
  assert.equal(demoAddressAllowed("127.0.0.1", 5000, [5000]), true);
  const staticDir = mkdtempSync(
    path.join(os.tmpdir(), "fieldwork-demo-shell-"),
  );
  writeFileSync(
    path.join(staticDir, "index.html"),
    "<!doctype html><html><head><title>Fixture</title></head><body></body></html>",
  );
  writeFileSync(path.join(staticDir, "fixture.js"), "window.demoAsset = true;");
  const demo = await startDemo(["--name", `test-${process.pid}`], {
    staticDir,
  });
  try {
    const state = await fetch(`${demo.url}/api/state`).then((res) =>
      res.json(),
    );
    for (const route of [
      "/",
      "/index.html",
      "//index.html",
      "/openings/fixture",
      "/missing-page",
    ]) {
      const html = await fetch(`${demo.url}${route}`).then((res) => res.text());
      assert.match(html, /<title>Fieldwork Demo<\/title>/, route);
      assert.match(
        html,
        /<script src="\/demo-navigation\.js"><\/script>/,
        route,
      );
    }
    const asset = await fetch(`${demo.url}/fixture.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "window.demoAsset = true;");
    const guard = await fetch(`${demo.url}/demo-navigation.js`);
    assert.equal(guard.status, 200);
    assert.equal(await guard.text(), demoNavigationGuard);
    assert.ok(
      state.openings.some((o: { id: string }) => o.id === "demo-opening-1"),
    );
    assert.ok(
      state.openings.every((o: { url: string }) =>
        /^https:\/\/(example\.(com|org)|job-boards\.greenhouse\.io\/northwindexample)\//.test(
          o.url,
        ),
      ),
    );
    const gmail = await fetch(`${demo.url}/api/gmail`).then((res) =>
      res.json(),
    );
    assert.equal(gmail.connected, false);
    assert.equal(gmail.checking, false);
    const theme = demoTheme;
    assert.deepEqual(state.settings.palette, {
      id: theme.id,
      knobs: theme.knobs,
      revision: 1,
    });
    assert.deepEqual(state.settings.themes, { items: [theme], revision: 1 });
    assert.equal(themeSaveProblem(theme), undefined);
    assert.equal(
      paletteSaveProblem(state.settings.palette, state.settings.themes.items),
      undefined,
    );
    assert.equal(state.greenhousePull.added, 5);
    assert.equal(state.greenhousePull.status, "paused");
    assert.equal(state.greenhousePull.policy.legacy, undefined);
    assert.equal(
      state.greenhousePull.policy.capturedAt,
      state.greenhousePull.createdAt,
    );
    assert.equal(state.greenhousePull.policy.freshnessDays, 7);
    const models = await fetch(`${demo.url}/api/agent/models`).then((res) =>
      res.json(),
    );
    assert.deepEqual(models.models, []);
    const write = await fetch(`${demo.url}/api/agent/connect`, {
      method: "POST",
    });
    assert.equal(write.status, 403);
    for (const route of [
      "/api/questions/context",
      "/api/questions/reference",
      "/api/tasks/demo-task/threads/demo-thread",
      "/api/tasks/demo-task",
      "/api/questions",
    ]) {
      const response = await fetch(`${demo.url}${route}`);
      assert.equal(response.status, 403, route);
      assert.match(
        (await response.json()).error,
        /Agents are disabled in the demo/,
      );
    }
    for (const route of [
      "/api/agent/status",
      "/api/system/activity",
      "/api/health",
    ]) {
      assert.equal((await fetch(`${demo.url}${route}`)).status, 200, route);
    }
    const application = await fetch(
      `${demo.url}/api/openings/demo-opening-1/application`,
    );
    assert.equal(application.status, 403);
    assert.match((await application.json()).error, /disabled in the demo/);
    const prepare = await fetch(
      `${demo.url}/api/openings/demo-opening-1/prepare`,
      { method: "POST" },
    );
    assert.equal(prepare.status, 403);
    assert.match((await prepare.json()).error, /disabled/);
    // All page-facing requests above must stay entirely within the demo.
    assert.equal(readFileSync(demo.logFile, "utf8"), "");
    for (const operation of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const) {
      assert.throws(
        () => Reflect.apply(childProcess[operation], childProcess, ["unused"]),
        /Demo blocks child process/,
      );
    }
    assert.throws(
      () =>
        Reflect.get(childProcess.ChildProcess.prototype, "spawn").call(
          new childProcess.ChildProcess(),
          {},
        ),
      /Demo blocks child process/,
    );
    assert.throws(() => dns.lookup("example.org", () => {}), /Demo blocks DNS/);
    assert.throws(() => dnsPromises.lookup("example.org"), /Demo blocks DNS/);
    assert.throws(
      () => dns.resolve4("example.org", () => {}),
      /Demo blocks DNS/,
    );
    assert.throws(
      () => new dns.Resolver().resolve4("example.org", () => {}),
      /Demo blocks DNS/,
    );
    assert.throws(
      () => new dnsPromises.Resolver().resolve4("example.org"),
      /Demo blocks DNS/,
    );
    assert.throws(() => dgram.createSocket("udp4"), /Demo blocks UDP/);
    const socket = new net.Socket();
    assert.throws(() => socket.connect(443, "example.org"), /Demo blocks/);
    assert.throws(
      () => net.createConnection({ port: 443, host: "example.org" }),
      /Demo blocks/,
    );
    assert.throws(
      () => net.createConnection({ port: 4317, host: "127.0.0.1" }),
      /Demo blocks/,
    );
    assert.throws(
      () => net.createConnection({ port: 44317, host: "127.0.0.1" }),
      /Demo blocks/,
    );
    assert.throws(
      () => net.createConnection({ port: 8931, host: "127.0.0.1" }),
      /Demo blocks/,
    );
    assert.match(readFileSync(demo.logFile, "utf8"), /"blocked":true/);
  } finally {
    await demo.close();
    rmSync(demo.layout.home, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
  }
});

test("demo shell removes external navigation without changing same-origin links", async () => {
  const dom = new JSDOM(
    '<a id="external" href="https://example.org/jobs/1">Role</a><a id="local" href="#openings">Openings</a>',
    { url: "http://127.0.0.1:5555", runScripts: "outside-only" },
  );
  try {
    dom.window.eval(demoNavigationGuard);
    assert.equal(
      dom.window.document.querySelector("#external")?.hasAttribute("href"),
      false,
    );
    assert.equal(
      dom.window.document.querySelector("#local")?.getAttribute("href"),
      "#openings",
    );
    assert.equal(dom.window.open("https://example.org"), null);
    const later = dom.window.document.createElement("a");
    later.href = "https://example.com/new-role";
    dom.window.document.body.append(later);
    await Promise.resolve();
    assert.equal(later.hasAttribute("href"), false);
  } finally {
    dom.window.close();
  }
});
