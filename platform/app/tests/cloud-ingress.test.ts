import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync, mkdtempSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace } from "../server/server.js";
import { createCloudIngress } from "../server/cloud-ingress.js";

const cloudHost = "fieldwork.example.com";
const publicOrigin = `https://${cloudHost}`;
const machineToken = "a".repeat(64);

test("cloud ingress rejects an unusable machine credential at construction", () => {
  assert.throws(
    () =>
      createCloudIngress(
        {
          ownerEmail: "sam.rivera@example.com",
          teamUrl: "https://fixture.cloudflareaccess.com",
          audience: "fieldwork-test-audience",
          publicOrigin,
        },
        "abcdefghijklmnopqrstuvwxyz_1234567890",
      ),
    /Invalid machine token/,
  );
});

type RunningWorkspace = {
  root: string;
  server: Server;
  workspace: Awaited<ReturnType<typeof createWorkspace>>;
  base: string;
};

function request(
  fixture: RunningWorkspace,
  route: string,
  options: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  const url = new URL(fixture.base + route);
  return new Promise<{
    status: number;
    headers: Headers;
    json: () => Promise<any>;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers: { Host: options.host ?? cloudHost, ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.from(chunk)),
        );
        response.on("error", reject);
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 500,
            headers: new Headers(response.headers as Record<string, string>),
            json: async () => JSON.parse(bytes.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () =>
      req.destroy(new Error("Cloud ingress fixture request timed out")),
    );
    req.end(options.body);
  });
}

async function openWorkspace(cloud: boolean): Promise<RunningWorkspace> {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-cloud-ingress-"));
  const workspace = await createWorkspace({
    root,
    dataDir: path.join(root, ".local"),
    port: 0,
    watch: false,
    connectAgent: false,
    ...(cloud
      ? {
          cloudAccess: {
            ownerEmail: "sam.rivera@example.com",
            teamUrl: "https://team.cloudflareaccess.com",
            audience: "audience_123456",
            publicOrigin,
          },
          machineToken,
        }
      : {}),
  });
  const server = workspace.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    root,
    workspace,
    server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function closeWorkspace(fixture: RunningWorkspace) {
  fixture.server.closeAllConnections();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  await fixture.workspace.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

test("cloud ingress protects every route and machine access retains request guards", async () => {
  const fixture = await openWorkspace(true);
  const machineHeaders = { "X-Fieldwork-Machine-Token": machineToken };
  try {
    for (const route of ["/", "/api/state", "/api/backup"])
      assert.equal((await request(fixture, route)).status, 401);

    assert.equal(
      (
        await request(fixture, "/api/state", {
          headers: { "X-Fieldwork-Machine-Token": "b".repeat(64) },
        })
      ).status,
      401,
    );

    const session = await request(fixture, "/api/session", {
      headers: machineHeaders,
    });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json();
    assert.match(csrfToken, /^[a-f0-9]{64}$/);

    assert.equal(
      (
        await request(fixture, "/api/state", {
          host: "unknown.example.com",
          headers: machineHeaders,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(fixture, "/api/state", {
          headers: { ...machineHeaders, Origin: "https://attacker.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(fixture, "/api/state", {
          headers: { ...machineHeaders, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(fixture, "/api/reindex", {
          method: "POST",
          headers: {
            ...machineHeaders,
            "Content-Type": "application/json",
            Origin: publicOrigin,
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(fixture, "/api/reindex", {
          method: "POST",
          headers: {
            ...machineHeaders,
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
            Origin: publicOrigin,
          },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(fixture, "/api/backup", {
          headers: machineHeaders,
        })
      ).status,
      200,
    );
  } finally {
    await closeWorkspace(fixture);
  }
});

test("local workspace keeps loopback access without cloud authentication", async () => {
  const fixture = await openWorkspace(false);
  try {
    assert.equal(
      (
        await request(fixture, "/api/session", {
          host: "127.0.0.1:0",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(fixture, "/api/session", {
          host: cloudHost,
        })
      ).status,
      403,
    );
  } finally {
    await closeWorkspace(fixture);
  }
});
