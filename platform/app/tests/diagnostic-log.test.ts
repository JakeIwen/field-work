import assert from "node:assert/strict";
import test from "node:test";
import {
  createProxyDiagnostics,
  diagnosticLog,
  setDiagnosticRole,
} from "../server/diagnostic-log.js";

test("diagnostics are single timestamped attributed lines with safe cause chains", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  setDiagnosticRole("mac-companion");
  try {
    const cause = Object.assign(new Error("connect failed\nretry"), {
      code: "ECONNREFUSED",
      body: "private response",
    });
    const error = new Error(
      "Read https://user:password@example.test/api?token=private#fragment",
      { cause },
    );
    diagnosticLog(
      "error",
      "probe",
      "Request failed",
      {
        port: 4317,
        authorization: "secret",
        url: "https://example.test/path?secret=yes",
      },
      error,
    );
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^\d{4}-\d{2}-\d{2}T\S+Z error role=mac-companion pid=\d+ component=probe /,
    );
    assert.match(lines[0], /port=4317/);
    assert.match(lines[0], /ECONNREFUSED/);
    assert.match(lines[0], /connect failed\\nretry/);
    assert.match(lines[0], /https:\/\/example.test\/api/);
    assert.equal(lines[0].includes("\n"), false);
    for (const value of [
      "user:password",
      "token=private",
      "fragment",
      "private response",
      "secret=yes",
      '"secret"',
    ])
      assert.equal(lines[0].includes(value), false, value);
  } finally {
    setDiagnosticRole("cloud-backend");
  }
});

test("proxy failures log first occurrence, minute summaries, and one recovery per route/code", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "warn", (line: string) => lines.push(line));
  t.mock.method(console, "log", (line: string) => lines.push(line));
  let at = 0;
  const logs = createProxyDiagnostics(() => at);
  const cause = Object.assign(new Error("secret request body"), {
    code: "EPIPE",
  });
  const error = Object.assign(
    new Error("https://user:pass@example.test/?token=secret", { cause }),
    { code: "ECONNREFUSED" },
  );
  for (let i = 0; i < 24; i++) {
    logs.failed(
      "GET",
      "/api/system/reload?token=secret",
      error,
      false,
      "Cloud unavailable",
    );
    at += 2500;
  }
  assert.equal(lines.length, 1);
  logs.failed("GET", "/api/system/reload", error, false, "Cloud unavailable");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /Proxy failures continue.*count=25/);
  logs.failed("GET", "/api/system/reload", error, false, "Cloud unavailable");
  assert.equal(lines.length, 2);
  logs.failed("GET", "/api/state", error, false, "Cloud unavailable");
  logs.failed(
    "GET",
    "/api/system/reload",
    Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    false,
    "Cloud unavailable",
  );
  assert.equal(lines.length, 4);
  logs.recovered("GET", "/api/system/reload");
  assert.equal(lines.length, 6);
  assert.match(lines[4], /Proxy connection recovered.*ECONNREFUSED.*count=26/);
  assert.match(lines[5], /Proxy connection recovered.*ETIMEDOUT.*count=1/);
  logs.recovered("GET", "/api/system/reload");
  assert.equal(lines.length, 6);
  logs.failed("GET", "/api/system/reload", error, false, "Cloud unavailable");
  assert.equal(lines.length, 7);
  assert.match(lines[6], /Cloud unavailable.*count=1/);
  assert.match(lines[0], /EPIPE/);
  assert.equal(lines.join("").includes("secret"), false);
  assert.equal(lines.join("").includes("user:pass"), false);
});
