import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import express from "express";
import {
  createCloudAccessMiddleware,
  resolveCloudAccessConfig,
  type CloudAccessConfig,
} from "../server/cloud-access.js";

const config: CloudAccessConfig = {
  ownerEmail: "sam.rivera@example.com",
  teamUrl: "https://team.cloudflareaccess.com",
  audience: "audience_123456",
  publicOrigin: "https://fieldwork.example.com",
  jwksCacheTtlMs: 1_000,
};

function keyPair(kid: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function token(
  key: ReturnType<typeof keyPair>,
  claims: Record<string, unknown> = {},
) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: key.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.teamUrl,
      aud: config.audience,
      email: config.ownerEmail,
      exp: 2_000,
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key.privateKey).toString("base64url")}`;
}

async function fixture(fetcher: typeof fetch, now = () => 1_000_000) {
  const app = express();
  app.use(
    createCloudAccessMiddleware(
      { ...config, ownerEmail: "  Sam.Rivera@Example.COM  " },
      { fetch: fetcher, now },
    ),
  );
  app.get("/api/events", (_req, res) =>
    res.type("text/event-stream").send("data: ok\n\n"),
  );
  app.get("/api/documents/one/download", (_req, res) => res.send("pdf"));
  app.get("/", (_req, res) => res.send("app"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jwksFetch(...keys: ReturnType<typeof keyPair>[]): typeof fetch {
  return async () => Response.json({ keys: keys.map((key) => key.jwk) });
}

test("cloud config is explicit, complete, and validates HTTPS origins", () => {
  assert.equal(resolveCloudAccessConfig({}), null);
  assert.throws(() =>
    resolveCloudAccessConfig({ FIELDWORK_CLOUD_TEAM_URL: config.teamUrl }),
  );
  assert.throws(() =>
    resolveCloudAccessConfig({
      FIELDWORK_CLOUD_ACCESS: "1",
      FIELDWORK_OWNER_EMAIL: config.ownerEmail,
      FIELDWORK_CLOUD_TEAM_URL: "http://team.example.com",
      FIELDWORK_CLOUD_ACCESS_AUD: config.audience,
      FIELDWORK_PUBLIC_ORIGIN: config.publicOrigin,
    }),
  );
  assert.deepEqual(
    resolveCloudAccessConfig({
      FIELDWORK_CLOUD_ACCESS: "1",
      FIELDWORK_OWNER_EMAIL: config.ownerEmail,
      FIELDWORK_CLOUD_TEAM_URL: config.teamUrl,
      FIELDWORK_CLOUD_ACCESS_AUD: config.audience,
      FIELDWORK_PUBLIC_ORIGIN: config.publicOrigin,
    }),
    {
      ownerEmail: config.ownerEmail,
      teamUrl: config.teamUrl,
      audience: config.audience,
      publicOrigin: config.publicOrigin,
    },
  );
});

test("middleware protects app, download, and SSE routes with a verified JWT", async () => {
  const key = keyPair("first");
  const f = await fixture(jwksFetch(key));
  try {
    for (const path of ["/", "/api/events", "/api/documents/one/download"]) {
      assert.equal((await fetch(f.url + path)).status, 401);
      assert.equal(
        (
          await fetch(f.url + path, {
            headers: {
              "Cf-Access-Jwt-Assertion": token(key, {
                email: "  SAM.rivera@EXAMPLE.com ",
              }),
            },
          })
        ).status,
        200,
      );
    }
  } finally {
    await f.close();
  }
});

test("middleware denies forged signatures, email headers, and invalid claims", async () => {
  const key = keyPair("trusted");
  const attacker = keyPair("trusted");
  const f = await fixture(jwksFetch(key));
  try {
    const attempts: RequestInit[] = [
      { headers: { "Cf-Access-Authenticated-User-Email": config.ownerEmail } },
      { headers: { "Cf-Access-Jwt-Assertion": token(attacker) } },
      {
        headers: {
          "Cf-Access-Jwt-Assertion": token(key, { email: "other@example.com" }),
        },
      },
      { headers: { "Cf-Access-Jwt-Assertion": token(key, { exp: 999 }) } },
      {
        headers: {
          "Cf-Access-Jwt-Assertion": token(key, { aud: "wrong_audience" }),
        },
      },
      {
        headers: {
          "Cf-Access-Jwt-Assertion": token(key, {
            iss: "https://other.cloudflareaccess.com",
          }),
        },
      },
    ];
    for (const init of attempts)
      assert.equal((await fetch(f.url, init)).status, 401);
  } finally {
    await f.close();
  }
});

test("unknown key refreshes a bounded cache for key rotation", async () => {
  const oldKey = keyPair("old");
  const newKey = keyPair("new");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({ keys: [(calls === 1 ? oldKey : newKey).jwk] });
  };
  const f = await fixture(fetcher);
  try {
    assert.equal(
      (
        await fetch(f.url, {
          headers: { "Cf-Access-Jwt-Assertion": token(oldKey) },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(f.url, {
          headers: { "Cf-Access-Jwt-Assertion": token(newKey) },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(f.url, {
          headers: { "Cf-Access-Jwt-Assertion": token(newKey) },
        })
      ).status,
      200,
    );
    assert.equal(calls, 2);
    const unknown = keyPair("unknown");
    assert.equal(
      (
        await fetch(f.url, {
          headers: { "Cf-Access-Jwt-Assertion": token(unknown) },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(f.url, {
          headers: { "Cf-Access-Jwt-Assertion": token(unknown) },
        })
      ).status,
      401,
    );
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test("only cloud mode requires an explicit owner identity", () => {
  const cloud = {
    FIELDWORK_CLOUD_ACCESS: "1",
    FIELDWORK_CLOUD_TEAM_URL: config.teamUrl,
    FIELDWORK_CLOUD_ACCESS_AUD: config.audience,
    FIELDWORK_PUBLIC_ORIGIN: config.publicOrigin,
  };
  for (const owner of [
    undefined,
    "",
    "not-an-email",
    "a@example.com\nother@example.com",
  ])
    assert.throws(
      () =>
        resolveCloudAccessConfig({ ...cloud, FIELDWORK_OWNER_EMAIL: owner }),
      /FIELDWORK_OWNER_EMAIL/,
    );
  assert.equal(resolveCloudAccessConfig({}), null);
  assert.equal(
    resolveCloudAccessConfig({ FIELDWORK_OWNER_EMAIL: config.ownerEmail }),
    null,
  );
  assert.equal(resolveCloudAccessConfig({ FIELDWORK_CLOUD_ACCESS: "0" }), null);
});
