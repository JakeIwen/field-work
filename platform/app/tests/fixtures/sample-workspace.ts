import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { sampleWorkspaceRoot } from "../../server/paths.js";

export { sampleWorkspaceRoot };

/** Tests that change authoritative sources get their own copy, removed even on setup failure. */
export function copySampleWorkspace(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-sample-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(sampleWorkspaceRoot, root, { recursive: true });
  return root;
}
