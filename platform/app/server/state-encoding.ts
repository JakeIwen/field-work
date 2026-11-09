import { tunableValue } from "../shared/tunables.js";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Response } from "express";

const brotliJson = promisify(brotliCompress);
const gzipJson = promisify(gzip);
type Encoding = "br" | "gzip";
type Pending = { json: string; quality: number; result: Promise<Buffer> };
const pending = new WeakMap<object, Map<Encoding, Set<Pending>>>();
let compressionTail: Promise<unknown> = Promise.resolve();

/** Bound native encoder memory even when different snapshots arrive together. */
function compress(
  json: string,
  encoding: Encoding,
  quality: number,
): Promise<Buffer> {
  const result = compressionTail.then(() =>
    encoding === "br"
      ? brotliJson(json, {
          params: { [constants.BROTLI_PARAM_QUALITY]: quality },
        })
      : gzipJson(json, { level: quality }),
  );
  compressionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Share only byte-identical in-flight encodings, never a previous read projection.
 * Files, clock-derived fields and runtime progress can change without a Store write. */
export function encodeState(owner: object, json: string, encoding: Encoding) {
  const settings =
    "settings" in owner && typeof owner.settings === "function"
      ? owner.settings()
      : {};
  const quality = tunableValue(
    settings,
    encoding === "br" ? "server.brotliQuality" : "server.gzipLevel",
  );
  let encodings = pending.get(owner);
  if (!encodings) pending.set(owner, (encodings = new Map()));
  let entries = encodings.get(encoding);
  if (!entries) encodings.set(encoding, (entries = new Set()));
  for (const entry of entries)
    if (entry.json === json && entry.quality === quality) return entry.result;
  const entry: Pending = {
    json,
    quality,
    result: compress(json, encoding, quality),
  };
  entries.add(entry);
  const remove = () => entries.delete(entry);
  void entry.result.then(remove, remove);
  return entry.result;
}

export function sendStateJson(
  res: Response,
  owner: object,
  json: string,
  encoding: string,
) {
  if (encoding !== "br" && encoding !== "gzip") {
    res.type("application/json").send(json);
    return;
  }
  // Only the shared encoder retains the input, not an async route's whole state graph.
  return encodeState(owner, json, encoding).then((bytes) => {
    res.set("Content-Encoding", encoding).type("application/json").send(bytes);
  });
}
