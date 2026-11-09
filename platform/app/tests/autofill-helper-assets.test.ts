import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autofillHelperFile } from "../server/paths.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fieldwork-autofill-assets-"));
  const platform = path.join(root, "platform");
  mkdirSync(platform);
  return {
    root,
    platform,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("source checkouts use the existing automation helper paths", () => {
  const f = fixture();
  try {
    assert.equal(
      fileURLToPath(autofillHelperFile("greenhouse", f.platform)),
      path.join(f.root, "automation/greenhouse/console-helper.js"),
    );
  } finally {
    f.close();
  }
});

test("packaged releases resolve each helper within their versioned code", () => {
  const f = fixture();
  try {
    for (const provider of ["greenhouse"] as const) {
      const directory = path.join(f.platform, "automation", provider);
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "console-helper.js");
      writeFileSync(file, "async function helper() {}\n");
      assert.equal(
        fileURLToPath(autofillHelperFile(provider, f.platform)),
        file,
      );
    }
  } finally {
    f.close();
  }
});

test("a missing packaged helper never silently falls back to stale external code", () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.platform, "automation"));
    const stale = path.join(f.root, "automation/greenhouse");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "console-helper.js"), "stale");
    assert.equal(
      fileURLToPath(autofillHelperFile("greenhouse", f.platform)),
      path.join(f.platform, "automation/greenhouse/console-helper.js"),
    );
  } finally {
    f.close();
  }
});
