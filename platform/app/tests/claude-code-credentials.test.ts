import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  claudeEnvironment,
  claudeCredentialPaths,
} from "../server/claude-code/session.js";
import { claudeFixture } from "./fixtures/claude-code-fixture.js";
import { maxContextSourceBytes } from "../server/context-source-limits.js";
import { ClaudeApprovals } from "../server/claude-code/approvals.js";

test("Claude sessions deny effective credential paths and omit service secrets", async () => {
  const keys = [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "FIELDWORK_TEST_SECRET",
    "ANTHROPIC_API_KEY",
  ];
  const before = keys.map((key) => process.env[key]);
  const fixture = claudeFixture();
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(fixture.root, "claude-config");
    process.env.CODEX_HOME = path.join(fixture.root, "codex-config");
    process.env.FIELDWORK_TEST_SECRET = "synthetic-secret";
    process.env.ANTHROPIC_API_KEY = "synthetic-api-key";
    const env = claudeEnvironment();
    assert.equal(env.FIELDWORK_TEST_SECRET, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
    // Whole captured sources (AGENTS.md, the evidence dossier) must reach purpose tasks inline.
    assert.equal(
      Number(env.MAX_MCP_OUTPUT_TOKENS),
      Math.ceil(maxContextSourceBytes / 3),
    );
    await fixture.adapter.start({ cwd: fixture.draft, prompt: "hello" });
    await fixture.turnEnded();
    const options = fixture.sessions[0].options;
    const paths = claudeCredentialPaths();
    assert.deepEqual(paths, [
      path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
      path.join(process.env.CODEX_HOME, "auth.json"),
    ]);
    assert.deepEqual(
      options.sandbox?.credentials?.files,
      paths.map((file) => ({ path: file, mode: "deny" })),
    );
    assert.deepEqual(options.settings, {
      permissions: { deny: paths.map((file) => `Read(/${file})`) },
    });
  } finally {
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
    fixture.cleanup();
  }
});

test("auto-approved reads cannot override a restricted path denial", async () => {
  const approvals = new ClaudeApprovals(() => {
    throw new Error("Must not prompt for restricted paths");
  });
  const result = await approvals.handler("thread", "turn", ["Read"])(
    "Read",
    { file_path: "/outside/secret" },
    {
      signal: new AbortController().signal,
      toolUseID: "tool",
      requestId: "request",
      blockedPath: "/outside/secret",
    },
  );
  assert.equal(result?.behavior, "deny");
  assert.deepEqual(approvals.requests(), []);
});
