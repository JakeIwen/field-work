import test from "node:test";
import assert from "node:assert/strict";
import {
  GmailError,
  GmailReconnectError,
  googleJson,
} from "../server/gmail/api.js";

const endpoint = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

test("disabled Gmail API names the client project without inventing a rate-limit cooldown", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: 403,
          message: "private-token must never be shown",
          status: "PERMISSION_DENIED",
          errors: [{ reason: "accessNotConfigured" }],
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "SERVICE_DISABLED",
              metadata: {
                service: "gmail.googleapis.com",
                consumer: "projects/123456789",
              },
            },
          ],
        },
      },
      { status: 403 },
    ),
  );
  await assert.rejects(googleJson(endpoint), (error) => {
    assert.ok(error instanceof GmailError);
    assert.match(error.message, /Gmail API is not enabled/);
    assert.match(error.message, /123456789/);
    assert.ok(!error.message.includes("private-token"));
    assert.equal(error.retryAt, undefined);
    return true;
  });
});

test("scope, policy, OAuth credentials and unclassified 403 errors give distinct recovery instructions", async (t) => {
  for (const [reason, expected] of [
    ["insufficientPermissions", /approve read-only/],
    ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", /approve read-only/],
    ["domainPolicy", /Workspace administrator/],
    ["invalid_grant", /expired or was revoked/],
    ["invalid_client", /OAuth client credentials/],
    ["access_denied", /OAuth test users/],
    ["unknown-secret-value", /HTTP 403/],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        { error: { errors: [{ reason }], message: "sensitive" } },
        { status: 403 },
      ),
    );
    await assert.rejects(googleJson(endpoint), (error) => {
      assert.ok(error instanceof GmailError);
      assert.match(error.message, expected);
      assert.equal(error.retryAt, undefined);
      assert.ok(!/unknown-secret-value|sensitive/.test(error.message));
      return true;
    });
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "invalid_grant", error_description: "private-secret" },
      { status: 400 },
    ),
  );
  await assert.rejects(googleJson(endpoint), (error) => {
    assert.ok(error instanceof GmailReconnectError);
    assert.match(error.message, /expired or was revoked/);
    return true;
  });
});

test("Google rate-limit reasons and HTTP 429 respect Retry-After in seconds and date form", async (t) => {
  const clock = 1791240000000;
  t.mock.method(Date, "now", () => clock);
  for (const status of [403, 429]) {
    for (const header of [
      "120",
      new Date(clock + 120000).toUTCString(),
      "invalid",
    ]) {
      t.mock.method(globalThis, "fetch", async () =>
        Response.json(
          { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
          { status, headers: { "Retry-After": header } },
        ),
      );
      await assert.rejects(googleJson(endpoint), (error) => {
        assert.ok(error instanceof GmailError);
        assert.match(error.message, /rate-limited/);
        assert.equal(
          error.retryAt,
          new Date(
            clock + (header === "invalid" ? 900000 : 120000),
          ).toISOString(),
        );
        return true;
      });
    }
  }
});

test("malformed denials and daily quota errors remain safe and actionable", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>private-secret</html>", { status: 403 }),
  );
  await assert.rejects(
    googleJson(endpoint),
    (error) =>
      error instanceof GmailError &&
      error.retryAt === undefined &&
      /HTTP 403/.test(error.message) &&
      !error.message.includes("private-secret"),
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { errors: [{ reason: "dailyLimitExceeded" }] } },
      { status: 403 },
    ),
  );
  await assert.rejects(
    googleJson(endpoint),
    (error) =>
      error instanceof GmailError &&
      !!error.retryAt &&
      /daily quota/.test(error.message),
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          details: [
            {
              reason: "SERVICE_DISABLED",
              metadata: { consumer: "projects/private-secret" },
            },
          ],
        },
      },
      { status: 403 },
    ),
  );
  await assert.rejects(
    googleJson(endpoint),
    (error) =>
      error instanceof GmailError &&
      /not enabled/.test(error.message) &&
      !error.message.includes("private-secret"),
  );
});
