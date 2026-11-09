import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { platformRoot } from "../server/paths.js";

const moduleUrl = new URL("../server/paths.ts", import.meta.url).href;
function pathsFrom(cwd: string, overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.JOB_SEARCH_ROOT;
  delete env.JOB_SEARCH_DATA;
  Object.assign(env, overrides);
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import * as paths from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(paths));`,
      ],
      { cwd, env, encoding: "utf8" },
    ),
  );
}

test("root, platform and unrelated working directories resolve the same existing data and assets", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "platform-paths-"));
  try {
    const expected = pathsFrom(platformRoot);
    assert.deepEqual(pathsFrom(path.dirname(platformRoot)), expected);
    assert.deepEqual(pathsFrom(outside), expected);
    assert.equal(expected.repositoryRoot, path.dirname(platformRoot));
    assert.equal(
      expected.dataDirectory,
      path.join(path.dirname(platformRoot), ".local/job-search"),
    );
    assert.ok(
      existsSync(path.join(expected.platformRoot, "package-lock.json")),
    );
    assert.ok(existsSync(expected.pdfVerifier));
    assert.ok(
      existsSync(path.join(expected.platformDocs, "opening-workflow.md")),
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("source/data overrides never relocate installed static assets or the trusted PDF validator", () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "platform-overrides-"));
  try {
    const normal = pathsFrom(platformRoot);
    const configured = pathsFrom(platformRoot, {
      JOB_SEARCH_ROOT: outside,
      JOB_SEARCH_DATA: path.join(outside, "personal"),
    });
    assert.equal(configured.repositoryRoot, outside);
    assert.equal(configured.dataDirectory, path.join(outside, "personal"));
    assert.equal(configured.platformBuild, normal.platformBuild);
    assert.equal(configured.pdfVerifier, normal.pdfVerifier);
    assert.equal(configured.platformDocs, normal.platformDocs);
    assert.equal(
      pathsFrom(outside, { JOB_SEARCH_DATA: "relative-data" }).dataDirectory,
      path.join(realpathSync(outside), "relative-data"),
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
