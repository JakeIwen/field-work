import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserTransportHeaders,
  cleanBrowserMcpUrl,
  liveBrowserOrigin,
} from "../server/browser-service.js";
import { LiveGreenhouseSource } from "../server/greenhouse-source.js";

const variables = [
  "FIELDWORK_COMPANION_ORIGIN",
  "FIELDWORK_MACHINE_TOKEN_FILE",
  "FIELDWORK_LIVE_BROWSER_ORIGIN",
  "FIELDWORK_CLEAN_BROWSER_ORIGIN",
] as const;

function environment() {
  const saved = Object.fromEntries(
    variables.map((name) => [name, process.env[name]]),
  );
  for (const name of variables) delete process.env[name];
  return () => {
    for (const name of variables) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("browser services retain direct local defaults", () => {
  const restore = environment();
  try {
    assert.equal(liveBrowserOrigin(), "http://127.0.0.1:61822");
    assert.equal(cleanBrowserMcpUrl(), "http://localhost:8931/mcp");
    assert.deepEqual(browserTransportHeaders(), {});
  } finally {
    restore();
  }
});

test("companion browser services use authenticated internal routes", async () => {
  const restore = environment();
  const directory = mkdtempSync(path.join(os.tmpdir(), "browser-service-"));
  const tokenFile = path.join(directory, "machine-token");
  const token = "a".repeat(64);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  process.env.FIELDWORK_COMPANION_ORIGIN = "http://127.0.0.1:44318";
  process.env.FIELDWORK_MACHINE_TOKEN_FILE = tokenFile;
  try {
    assert.equal(
      liveBrowserOrigin(),
      "http://127.0.0.1:44318/internal/browser-live",
    );
    assert.equal(
      cleanBrowserMcpUrl(),
      "http://127.0.0.1:44318/internal/browser-clean/mcp",
    );
    assert.deepEqual(browserTransportHeaders(), {
      "X-Fieldwork-Machine-Token": token,
    });
    const greenhouseRequests: {
      url: string;
      method: string;
      token: string | null;
    }[] = [];
    const greenhouse = new LiveGreenhouseSource(
      { read: () => "owned-tab", write: () => {} },
      async (input, init) => {
        greenhouseRequests.push({
          url: String(input),
          method: init?.method ?? "GET",
          token: new Headers(init?.headers).get("x-fieldwork-machine-token"),
        });
        return Response.json(
          greenhouseRequests.length === 1
            ? { url: "https://my.greenhouse.io/jobs/search" }
            : {},
        );
      },
    );
    await greenhouse.close();
    assert.deepEqual(
      greenhouseRequests.map(({ url, method, token: supplied }) => ({
        path: new URL(url).pathname,
        method,
        supplied,
      })),
      [
        {
          path: "/internal/browser-live/tab/owned-tab",
          method: "GET",
          supplied: token,
        },
        {
          path: "/internal/browser-live/tab/owned-tab",
          method: "DELETE",
          supplied: token,
        },
      ],
    );
  } finally {
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("companion browser origin rejects non-loopback destinations", () => {
  const restore = environment();
  process.env.FIELDWORK_COMPANION_ORIGIN = "https://example.com";
  try {
    assert.throws(() => liveBrowserOrigin(), /HTTP loopback origin/);
    assert.throws(() => cleanBrowserMcpUrl(), /HTTP loopback origin/);
  } finally {
    restore();
  }
});

test("clean-browser MCP sends companion authentication on every transport call", async () => {
  const restore = environment();
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "clean-browser-service-"),
  );
  const tokenFile = path.join(directory, "machine-token");
  const token = "b".repeat(64);
  writeFileSync(tokenFile, token, { mode: 0o600 });
  process.env.FIELDWORK_COMPANION_ORIGIN = "http://127.0.0.1:44318";
  process.env.FIELDWORK_MACHINE_TOKEN_FILE = tokenFile;
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; token: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      token: new Headers(init?.headers).get("x-fieldwork-machine-token"),
    });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (!init?.method) {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.close(), {
            once: true,
          });
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const body = JSON.parse(String(init.body));
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-11-25" }
        : {
            content: [
              {
                type: "text",
                text: '### Result\n{"url":"https://example.com/jobs","status":200,"html":"<main>Job</main>","settled":true,"blockedEssential":0}',
              },
            ],
          };
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "Mcp-Session-Id": "clean-session" } },
    );
  };
  try {
    const { renderCareerPage } = await import("../server/careers/browser.js");
    const result = await renderCareerPage("https://example.com/jobs");
    assert.equal(result.status, 200);
    assert.ok(requests.length >= 5);
    assert.ok(
      requests.every(
        (request) =>
          request.url === "http://127.0.0.1:44318/internal/browser-clean/mcp" &&
          request.token === token,
      ),
    );
    assert.ok(requests.some((request) => request.method === "GET"));
    assert.ok(requests.some((request) => request.method === "DELETE"));
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});
