import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { RequestHandler } from "express";
import {
  readCompanionConfig,
  validateCompanionConfig,
  type CompanionConfig,
} from "../server/companion-config.js";
import {
  companionSshArguments,
  createCompanionTunnel,
} from "../server/companion-tunnel.js";
import { companionBrowserPorts } from "../server/companion-browser.js";
import { publishPreview } from "../scripts/preview-deployment.js";
import { companionProxyHeaders, createCompanion } from "../server/companion.js";

const config: CompanionConfig = {
  sshTarget: "fieldwork@example.test",
  sshIdentityFile: "/Users/sampleuser/.ssh/fieldwork",
  cloudOrigin: "https://fieldwork.example.test",
  cloudPort: 4317,
  localForwardPort: 44317,
  remoteForwardPort: 44318,
  machineToken: "a".repeat(64),
};

class FakeChild extends EventEmitter {
  killedWith?: NodeJS.Signals;
  kill(signal?: NodeJS.Signals) {
    this.killedWith = signal;
    if (signal === "SIGTERM") process.nextTick(() => this.emit("exit", 0));
    return true;
  }
}

function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      server.close(() => resolve(address.port));
    });
  });
}

function requestWithHost(
  port: number,
  path: string,
  host: string,
  token?: string,
  extraHeaders: Record<string, string> = {},
  method = "POST",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Host: host,
          ...(token ? { "x-fieldwork-machine-token": token } : {}),
          ...extraHeaders,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("companion config validates destinations and requires a private owner-only file", () => {
  assert.deepEqual(validateCompanionConfig(config), config);
  const custom = {
    ...config,
    sshTarget: "operator@cloud.example.test",
    cloudOrigin: "https://workspace.example.test:8443",
  };
  assert.deepEqual(validateCompanionConfig(custom), custom);
  for (const sshTarget of [
    "-oProxyCommand=bad",
    "user@host bad",
    "user@",
    "",
    1,
  ])
    assert.throws(() => validateCompanionConfig({ ...config, sshTarget }));
  for (const cloudOrigin of [
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test/",
    "https://example.test:443",
    "https://example.test/path",
    "https://example.test?query=1",
    "https://example.test#fragment",
    "invalid",
    1,
  ])
    assert.throws(() => validateCompanionConfig({ ...config, cloudOrigin }));
  assert.throws(() => validateCompanionConfig({ ...config, cloudPort: 4318 }));
  assert.throws(() => validateCompanionConfig({ ...config, extra: true }));
  assert.throws(() =>
    validateCompanionConfig({ ...config, machineToken: "short" }),
  );
  for (const token of [
    "g".repeat(64),
    "A".repeat(64),
    "a".repeat(32),
    "abcdefghijklmnopqrstuvwxyz_1234567890",
  ])
    assert.throws(() =>
      validateCompanionConfig({ ...config, machineToken: token }),
    );
  const directory = mkdtempSync(path.join(os.tmpdir(), "fieldwork-companion-"));
  try {
    const file = path.join(directory, "companion.json");
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(readCompanionConfig(file), config);
    const link = path.join(directory, "linked.json");
    symlinkSync(file, link);
    assert.throws(() => readCompanionConfig(link), /regular mode 600/);
    chmodSync(file, 0o644);
    assert.throws(() => readCompanionConfig(file), /mode 600/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SSH tunnel pins noninteractive options and every loopback forward", () => {
  const args = companionSshArguments(config);
  assert.deepEqual(args.slice(0, 20), [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
  ]);
  assert(args.includes("127.0.0.1:44317:127.0.0.1:4317"));
  assert(args.includes("127.0.0.1:44318:127.0.0.1:4317"));
  assert(!args.some((arg) => arg.includes("46182") || arg.includes("48931")));
  assert(!args.some((arg) => arg.includes("4433")));
  assert.equal(args.at(-1), config.sshTarget);
  assert(args.includes("ConnectTimeout=10"));
  assert(args.includes("ConnectionAttempts=1"));
});

test("browser capabilities are authenticated fixed proxies without credential forwarding", async () => {
  const browserPort = await availablePort();
  let received:
    | { headers: http.IncomingHttpHeaders; path?: string; method?: string }
    | undefined;
  const browser = http.createServer((req, res) => {
    received = { headers: req.headers, path: req.url, method: req.method };
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "mcp-session-id": "session-one",
    });
    res.write("data: first\n\n");
    res.end("data: second\n\n");
  });
  await new Promise<void>((resolve) =>
    browser.listen(browserPort, "127.0.0.1", resolve),
  );
  const port = await availablePort();
  const child = new FakeChild();
  const companion = createCompanion({
    root: process.cwd(),
    dataDir: process.cwd(),
    port,
    config,
    shutdown: () => {},
    spawn: (() => child as unknown as ChildProcess) as never,
    browserPorts: { clean: browserPort, live: browserPort },
  });
  const server = companion.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const forwardHost = `127.0.0.1:${config.remoteForwardPort}`;
  try {
    assert.equal(companionBrowserPorts.clean, 8931);
    assert.equal(companionBrowserPorts.live, 61822);
    assert.equal(
      (await requestWithHost(port, "/internal/browser-clean/mcp", forwardHost))
        .status,
      401,
    );
    assert.equal(
      (
        await requestWithHost(
          port,
          "/internal/browser-clean/mcp",
          forwardHost,
          config.machineToken,
          { Origin: "https://fieldwork.example.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await requestWithHost(
          port,
          "/internal/browser-clean/unknown",
          forwardHost,
          config.machineToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await requestWithHost(
          port,
          "/internal/browser-clean/mcp",
          "localhost:9999",
          config.machineToken,
        )
      ).status,
      403,
    );
    const streamed = await requestWithHost(
      port,
      "/internal/browser-clean/mcp?fixture=1",
      forwardHost,
      config.machineToken,
      {
        Authorization: "secret",
        "Cf-Access-Jwt-Assertion": "secret",
        "Mcp-Session-Id": "session-request",
      },
    );
    assert.equal(streamed.status, 200);
    assert.equal(streamed.body, "data: first\n\ndata: second\n\n");
    assert.equal(received?.path, "/mcp?fixture=1");
    assert.equal(received?.headers.host, `localhost:${browserPort}`);
    assert.equal(received?.headers.authorization, undefined);
    assert.equal(received?.headers["cf-access-jwt-assertion"], undefined);
    assert.equal(received?.headers["x-fieldwork-machine-token"], undefined);
    assert.equal(received?.headers["mcp-session-id"], "session-request");
  } finally {
    await companion.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => browser.close(() => resolve()));
  }
});

test("tunnel reports connection only after a health probe and awaits SSH exit", async () => {
  const child = new FakeChild();
  const calls: unknown[][] = [];
  const health = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const address = health.address();
  assert(address && typeof address === "object");
  const tunnelConfig = {
    ...config,
    localForwardPort: address.port as 44317,
  };
  const tunnel = createCompanionTunnel(tunnelConfig, {
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      return child as unknown as ChildProcess;
    }) as never,
  });
  tunnel.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/ssh");
  assert.equal(tunnel.connected(), false);
  child.emit("spawn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tunnel.connected(), true);
  await tunnel.close();
  assert.equal(tunnel.connected(), false);
  assert.equal(child.killedWith, "SIGTERM");
  await new Promise<void>((resolve) => health.close(() => resolve()));
});

test("proxy headers remove caller authentication and add only the machine token", () => {
  const headers = companionProxyHeaders(
    {
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      authorization: "secret",
      "cf-access-jwt-assertion": "forged",
      "cf-access-authenticated-user-email": "forged@example.com",
      "x-fieldwork-machine-token": "forged",
      connection: "x-hidden, keep-alive",
      "x-hidden": "secret",
      accept: "text/event-stream",
    },
    config,
  );
  assert.equal(headers.host, "fieldwork.example.test");
  assert.equal(headers.origin, config.cloudOrigin);
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["x-hidden"], undefined);
  assert.equal(headers["cf-access-jwt-assertion"], undefined);
  assert.equal(headers["x-fieldwork-machine-token"], config.machineToken);
});

test("companion endpoints stay local and render requires the machine token", async () => {
  const port = await availablePort();
  const child = new FakeChild();
  let stopped = false;
  const renderHandler: RequestHandler = (_req, res) =>
    res.json({ rendered: true });
  const companion = createCompanion({
    root: process.cwd(),
    dataDir: process.cwd(),
    port,
    config,
    shutdown: () => {
      stopped = true;
    },
    renderHandler,
    spawn: (() => child as unknown as ChildProcess) as never,
  });
  const server = companion.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(url + "/api/companion/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      ((await health.json()) as { connected: boolean }).connected,
      false,
    );
    assert.equal((await fetch(url + "/internal/render")).status, 401);
    assert.equal(
      (
        await fetch(url + "/internal/render", {
          headers: { "x-fieldwork-machine-token": config.machineToken },
        })
      ).status,
      200,
    );
    const session = (await (
      await fetch(url + "/api/companion/session")
    ).json()) as { csrfToken: string };
    assert.equal(
      (await fetch(url + "/api/companion/stop", { method: "POST" })).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/api/companion/stop", {
          method: "POST",
          headers: { "x-csrf-token": session.csrfToken },
        })
      ).status,
      202,
    );
    assert.equal(stopped, true);
    assert.equal(
      (
        await fetch(url + "/api/companion/health", {
          headers: { Origin: "https://fieldwork.example.test" },
        })
      ).status,
      403,
    );
  } finally {
    await companion.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reverse-forward Host is accepted only for authenticated rendering", async () => {
  const port = await availablePort();
  const child = new FakeChild();
  const companion = createCompanion({
    root: process.cwd(),
    dataDir: process.cwd(),
    port,
    config,
    shutdown: () => {},
    renderHandler: (_req, res) => res.json({ rendered: true }),
    spawn: (() => child as unknown as ChildProcess) as never,
  });
  const server = companion.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const forwardedHost = `127.0.0.1:${config.remoteForwardPort}`;
  try {
    const valid = await requestWithHost(
      port,
      "/internal/render",
      forwardedHost,
      config.machineToken,
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(JSON.parse(valid.body), { rendered: true });
    assert.equal(
      (await requestWithHost(port, "/internal/render", forwardedHost, "wrong"))
        .status,
      401,
    );
    assert.equal(
      (await requestWithHost(port, "/api/session", forwardedHost)).status,
      403,
    );
  } finally {
    await companion.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ordinary responses stream through the proxy with hop headers removed", async () => {
  const upstreamPort = await availablePort();
  let received: http.IncomingHttpHeaders | undefined;
  const upstream = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(206, {
      "content-type": "text/plain",
      connection: "x-upstream-secret",
      "x-upstream-secret": "hidden",
      "x-visible": "kept",
    });
    res.write("stream-");
    setTimeout(() => res.end("complete"), 5);
  });
  await new Promise<void>((resolve) =>
    upstream.listen(upstreamPort, "127.0.0.1", resolve),
  );
  const port = await availablePort();
  const child = new FakeChild();
  const companion = createCompanion({
    root: process.cwd(),
    dataDir: process.cwd(),
    port,
    config: { ...config, localForwardPort: upstreamPort as 44317 },
    shutdown: () => {},
    spawn: (() => child as unknown as ChildProcess) as never,
  });
  const server = companion.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        Authorization: "caller-secret",
      },
    });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "stream-complete");
    assert.equal(response.headers.get("x-visible"), "kept");
    assert.equal(response.headers.get("x-upstream-secret"), null);
    assert.equal(received?.host, "fieldwork.example.test");
    assert.equal(received?.origin, config.cloudOrigin);
    assert.equal(received?.authorization, undefined);
    assert.equal(received?.["x-fieldwork-machine-token"], config.machineToken);
  } finally {
    await companion.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

async function localPreviewFixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "companion-preview-"));
  const stage = path.join(directory, "stage");
  mkdirSync(path.join(stage, "assets"), { recursive: true });
  writeFileSync(path.join(stage, "index.html"), "<html>local-one</html>");
  writeFileSync(path.join(stage, "assets/one.js"), "local chunk one");
  writeFileSync(path.join(stage, "appearance-boot.js"), "boot");
  const cloudRequests: string[] = [];
  const cloud = http.createServer((req, res) => {
    cloudRequests.push(req.url ?? "");
    res.statusCode = req.url === "/api/missing" ? 404 : 200;
    res.end("cloud:" + req.url);
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert(address && typeof address === "object");
  const port = await availablePort();
  const companion = createCompanion({
    root: directory,
    dataDir: directory,
    port,
    config: { ...config, localForwardPort: address.port as 44317 },
    shutdown: () => {},
    spawn: (() => new FakeChild() as unknown as ChildProcess) as never,
  });
  const server = companion.app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await companion.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, stage, port, base, cloudRequests };
}

test("companion serves atomic local previews while APIs stay cloud-routed", async (t) => {
  const { directory, stage, base, cloudRequests } =
    await localPreviewFixture(t);
  assert.equal((await fetch(base)).status, 503);
  assert.equal(
    await (await fetch(base + "/api/state")).text(),
    "cloud:/api/state",
  );
  publishPreview(directory, stage);
  for (const route of ["/", "/openings", "/settings?preview=1"]) {
    const response = await fetch(base + route);
    assert.equal(await response.text(), "<html>local-one</html>");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /script-src 'self'/,
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(
    await (await fetch(base + "/assets/one.js")).text(),
    "local chunk one",
  );
  assert.equal(
    await (await fetch(base + "/appearance-boot.js")).text(),
    "boot",
  );
  assert.equal((await fetch(base, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(base, { method: "POST" })).status, 405);
  for (const route of [
    "/assets/missing.js",
    "/missing.css",
    "/assets/no-extension",
  ]) {
    assert.equal((await fetch(base + route)).status, 404);
    assert(!cloudRequests.includes(route));
  }
  assert.equal((await fetch(base + "/api/missing")).status, 404);
  assert(cloudRequests.includes("/api/missing"));
  writeFileSync(path.join(stage, "index.html"), "<html>local-two</html>");
  rmSync(path.join(stage, "assets/one.js"));
  writeFileSync(path.join(stage, "assets/two.js"), "local chunk two");
  publishPreview(directory, stage);
  assert.equal(await (await fetch(base)).text(), "<html>local-two</html>");
  assert.equal(
    await (await fetch(base + "/assets/one.js")).text(),
    "local chunk one",
  );
});

test("local preview retains host/origin guards and rejects unsafe paths", async (t) => {
  const { directory, stage, base, port } = await localPreviewFixture(t);
  publishPreview(directory, stage);
  for (const route of [
    "/%2e%2e%2fsecret",
    "/%61pi/state",
    "/assets/%zz",
    "/assets/a%5cb",
  ]) {
    assert.equal((await fetch(base + route)).status, 400);
  }
  symlinkSync(
    path.join(directory, "companion.json"),
    path.join(stage, "leak.js"),
  );
  assert.throws(() => publishPreview(directory, stage), /symlink/);
  rmSync(path.join(stage, "leak.js"));
  writeFileSync(path.join(directory, "secret.js"), "secret");
  symlinkSync(
    path.join(directory, "secret.js"),
    path.join(directory, "preview-client/assets/leak.js"),
  );
  assert.equal((await fetch(base + "/assets/leak.js")).status, 404);
  assert.equal(
    (await fetch(base, { headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  assert.equal(
    (await requestWithHost(port, "/", "evil.example", undefined, {}, "GET"))
      .status,
    403,
  );
  assert.equal(
    (await fetch(base, { headers: { "sec-fetch-site": "cross-site" } })).status,
    403,
  );
});

test("tunnel ignores old health callbacks and cancels connection-owned requests", async () => {
  const child = new FakeChild();
  const callbacks: Array<(response: http.IncomingMessage) => void> = [];
  const requests: Array<
    EventEmitter & { destroyed: boolean; end(): void; destroy(): void }
  > = [];
  const pending = new Set<unknown>();
  const tunnel = createCompanionTunnel(config, {
    spawn: (() => child as unknown as ChildProcess) as never,
    request: ((
      _options: unknown,
      callback: (response: http.IncomingMessage) => void,
    ) => {
      callbacks.push(callback);
      const emitter = new EventEmitter();
      const request = Object.assign(emitter, {
        destroyed: false,
        end() {},
        destroy() {
          this.destroyed = true;
          emitter.emit("error", new Error("cancelled"));
        },
      });
      requests.push(request);
      return request;
    }) as unknown as typeof http.request,
    setTimeout: ((callback: () => void) => {
      pending.add(callback);
      return callback;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((callback: unknown) => {
      pending.delete(callback);
    }) as typeof clearTimeout,
  });
  tunnel.start();
  child.emit("spawn");
  assert.equal(requests.length, 1);
  child.emit("exit", 1);
  assert.equal(requests[0].destroyed, true);
  const scheduled = pending.size;
  callbacks[0]({
    statusCode: 200,
    resume() {},
  } as unknown as http.IncomingMessage);
  assert.equal(tunnel.connected(), false);
  assert.equal(pending.size, scheduled);
  await tunnel.close();
  callbacks[0]({
    statusCode: 200,
    resume() {},
  } as unknown as http.IncomingMessage);
  assert.equal(tunnel.connected(), false);
  assert.equal(pending.size, 0);
});
