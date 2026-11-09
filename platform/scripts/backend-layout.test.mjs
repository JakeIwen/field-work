import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkBackendLayout,
  contractTargets,
  families,
} from "./check-backend-layout.mjs";

const realRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fieldwork-backend-layout-"));
  const server = path.join(root, "platform/app/server");
  const client = path.join(root, "platform/app/client");
  mkdirSync(client, { recursive: true });
  mkdirSync(server, { recursive: true });
  writeFileSync(path.join(client, "main.ts"), "export {};\n");
  writeFileSync(path.join(server, "index.ts"), 'import "./paths.js";\n');
  writeFileSync(path.join(server, "paths.ts"), "export {};\n");
  for (const [family, files] of Object.entries(families)) {
    mkdirSync(path.join(server, family), { recursive: true });
    for (const file of files)
      writeFileSync(path.join(server, family, file), "export {};\n");
  }
  for (const target of contractTargets) {
    const file = path.join(root, target);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!target.endsWith("index.ts") || !file.startsWith(server))
      writeFileSync(file, "export {};\n");
  }
  const rows = contractTargets
    .map((target) => `| \`${target}\` | fixture caller | \`${target}\` |`)
    .join("\n");
  writeFileSync(
    path.join(root, "AGENTS.md"),
    `# Fixture\n\n## Contracts\n\n| Path | Caller | Owner |\n|---|---|---|\n${rows}\n`,
  );
  writeFileSync(path.join(root, "package.json"), "{}\n");
  return root;
}

function run(root) {
  return checkBackendLayout(root, { typescriptRoot: realRoot });
}

test("accepts completed feature ownership and declared targets", () => {
  const root = fixture();
  try {
    assert.deepEqual(run(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing declared targets and flat feature regressions", () => {
  const root = fixture();
  try {
    rmSync(path.join(root, contractTargets[1]));
    writeFileSync(
      path.join(root, "platform/app/server/gmail-scan.ts"),
      "export {};\n",
    );
    const problems = run(root);
    assert.ok(
      problems.some((problem) =>
        problem.includes("Declared target does not exist"),
      ),
    );
    assert.ok(
      problems.some((problem) => problem.includes("ownership regressed")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects client-to-backend and pure-rule runtime dependencies while allowing type imports", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "platform/app/client/main.ts"),
      'import "../server/autofill/profile.js";\n',
    );
    writeFileSync(
      path.join(root, "platform/app/server/autofill/declarations.ts"),
      'import type { X } from "../storage.js";\nimport "../routes/system.js";\n',
    );
    mkdirSync(path.join(root, "platform/app/server/routes"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "platform/app/server/routes/system.ts"),
      "export {};\n",
    );
    writeFileSync(
      path.join(root, "platform/app/server/storage.ts"),
      "export type X = string;\n",
    );
    const problems = run(root);
    assert.ok(
      problems.some((problem) =>
        problem.includes("client imports backend feature"),
      ),
    );
    assert.ok(
      problems.some((problem) =>
        problem.includes("pure rule imports runtime adapter"),
      ),
    );
    assert.equal(
      problems.some((problem) =>
        problem.includes("declarations.ts -> storage.ts"),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository satisfies its declared backend boundaries", () => {
  assert.deepEqual(checkBackendLayout(realRoot), []);
});
