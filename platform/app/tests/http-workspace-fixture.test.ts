import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "node:http";
import { Store } from "../server/storage.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

test("HTTP fixture initialization failure closes its Store and listener", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-init-failure-"));
  const originalClose = Store.prototype.close,
    realFetch = globalThis.fetch;
  let closed = 0,
    url = "";
  t.mock.method(Store.prototype, "close", function (this: Store) {
    closed++;
    originalClose.call(this);
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    url = String(input);
    throw new Error("Injected session fetch failure");
  });
  try {
    await assert.rejects(
      openFixtureWorkspace(root),
      /Injected session fetch failure/,
    );
    assert.equal(closed, 1);
    await assert.rejects(realFetch(url, { signal: AbortSignal.timeout(1000) }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP fixture closes its Store even when server close reports failure", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fixture-close-failure-"));
  const f = await openFixtureWorkspace(root);
  const originalClose = Server.prototype.close,
    closeStore = f.store.close.bind(f.store);
  let closed = 0;
  t.mock.method(f.store, "close", () => {
    closed++;
    closeStore();
  });
  t.mock.method(
    Server.prototype,
    "close",
    function (this: Server, callback?: (error?: Error) => void) {
      return originalClose.call(this, () =>
        callback?.(new Error("Injected close failure")),
      );
    },
  );
  try {
    await assert.rejects(f.close(), /Injected close failure/);
    assert.equal(closed, 1);
    await assert.rejects(f.close(), /Injected close failure/);
    assert.equal(closed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
