import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { syncBuiltinESMExports } from "node:module";

// Count real native encoders, rather than substituting their bytes or completion.
test("distinct and mixed snapshots use at most one native compressor and identical requests share it", async (t) => {
  let active = 0,
    peak = 0,
    calls = 0;
  const originalBrotli = zlib.brotliCompress;
  const originalGzip = zlib.gzip;
  const completion = (callback: zlib.CompressCallback) => {
    calls++;
    peak = Math.max(peak, ++active);
    return (error: Error | null, bytes: Buffer) => {
      active--;
      callback(error, bytes);
    };
  };
  t.mock.method(
    zlib,
    "brotliCompress",
    (
      input: zlib.InputType,
      options: zlib.BrotliOptions,
      callback: zlib.CompressCallback,
    ) => originalBrotli(input, options, completion(callback)),
  );
  t.mock.method(
    zlib,
    "gzip",
    (
      input: zlib.InputType,
      options: zlib.ZlibOptions,
      callback: zlib.CompressCallback,
    ) => originalGzip(input, options, completion(callback)),
  );
  syncBuiltinESMExports();
  const { encodeState } = await import("../server/state-encoding.js");
  try {
    const owner = {};
    const json = JSON.stringify({
      text: "Distinct snapshot data. ".repeat(10000),
    });
    const repeated = Array.from({ length: 6 }, () =>
      encodeState(owner, json, "br"),
    );
    const changed = encodeState(owner, json + " ", "br");
    const gzip = encodeState(owner, json, "gzip");
    const results = await Promise.all([...repeated, changed, gzip]);
    assert.equal(calls, 3);
    assert.equal(peak, 1);
    assert.equal(active, 0);
    for (const bytes of results.slice(0, 6))
      assert.equal(zlib.brotliDecompressSync(bytes).toString(), json);
    assert.equal(zlib.brotliDecompressSync(results[6]).toString(), json + " ");
    assert.equal(zlib.gunzipSync(results[7]).toString(), json);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
