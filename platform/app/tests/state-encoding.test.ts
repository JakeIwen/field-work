import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync, gunzipSync } from "node:zlib";
import { encodeState } from "../server/state-encoding.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { legacyTask } from "./fixtures/legacy-records.js";

function rawState(base: string, encoding: string) {
  return new Promise<Buffer>((resolve, reject) => {
    get(
      base + "/api/state",
      { headers: { "Accept-Encoding": encoding } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) reject(Error(`HTTP ${res.statusCode}`));
          else resolve(Buffer.concat(chunks));
        });
        res.on("error", reject);
      },
    ).on("error", reject);
  });
}

test("identical in-flight snapshots share encoded bytes, but changed content, owners and completed reads do not", async () => {
  const owner = {};
  const json = JSON.stringify({ text: "Résumé — 保留\n".repeat(10000) });
  const first = encodeState(owner, json, "br");
  assert.equal(encodeState(owner, json, "br"), first);
  const changed = encodeState(owner, json + " ", "br");
  const other = encodeState({}, json, "br");
  const gzip = encodeState(owner, json, "gzip");
  assert.notEqual(changed, first);
  assert.notEqual(other, first);
  assert.notEqual(gzip, first);
  const [a, b, c, d] = await Promise.all([first, changed, other, gzip]);
  assert.deepEqual(
    a,
    brotliCompressSync(json, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }),
  );
  assert.deepEqual(
    b,
    brotliCompressSync(json + " ", {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }),
  );
  assert.deepEqual(c, a);
  assert.deepEqual(d, gzipSync(json, { level: 6 }));
  const later = encodeState(owner, json, "br");
  assert.notEqual(later, first);
  assert.deepEqual(await later, a);
});

test("concurrent HTTP snapshots preserve every compressed byte and each request reads current state", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-state-encoding-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    workspace.store.put(
      "task",
      "one",
      legacyTask({
        id: "one",
        messages: [{ text: "Synthetic Unicode résumé. ".repeat(10000) }],
      }),
    );
    const base = new URL((await workspace.get("/api/health")).url).origin;
    const original = workspace.store.state.bind(workspace.store);
    let builds = 0;
    t.mock.method(workspace.store, "state", () => {
      builds++;
      return original();
    });
    const identity = await rawState(base, "identity");
    const compressed = await Promise.all(
      Array.from({ length: 6 }, () => rawState(base, "br")),
    );
    const expected = brotliCompressSync(identity, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    });
    for (const bytes of compressed) assert.deepEqual(bytes, expected);
    assert.equal(
      builds,
      7,
      "Filesystem and clock-dependent projections must still be read per request",
    );
    await workspace.post("/api/personal/one", {
      expectedVersion: 0,
      notes: "Newly committed",
    });
    const updated = await rawState(base, "gzip");
    assert.equal(
      JSON.parse(gunzipSync(updated).toString()).personal.one.notes,
      "Newly committed",
    );
    workspace.store.remove("personal", "one");
    const removed = JSON.parse((await rawState(base, "identity")).toString());
    assert.equal(removed.personal.one, undefined);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
