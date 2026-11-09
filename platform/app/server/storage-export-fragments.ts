import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { atomicWrite, type Store } from "./storage.js";
import { personalExportKinds } from "./storage-export-snapshot.js";
import {
  personalExportChunks,
  personalExportKindChunks,
} from "./storage-export-json.js";
import type { PersonalExportKind } from "./storage-export-dirty.js";

type ExportStore = Pick<Store, "db" | "dataDir">;
type Fragments = { registry: string; hashes: Map<PersonalExportKind, string> };
const caches = new WeakMap<ExportStore, Fragments>();
const chunkBytes = 64 * 1024;
const fragmentPath = (directory: string, kind: PersonalExportKind) =>
  path.join(directory, `${kind}.json`);

/** Never hydrate an entire kind, including during integrity verification. */
function* readChunks(file: string): Generator<string> {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile())
      throw Error("Export fragment is not a regular file");
    const buffer = Buffer.alloc(chunkBytes);
    const decoder = new StringDecoder("utf8");
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)))
      yield decoder.write(buffer.subarray(0, bytes));
    yield decoder.end();
  } finally {
    closeSync(fd);
  }
}

function fragmentsIntact(
  directory: string,
  cache: Fragments,
  registry: string,
) {
  if (cache.registry !== registry) return false;
  try {
    return personalExportKinds.every((kind) => {
      const hash = createHash("sha256");
      for (const chunk of readChunks(fragmentPath(directory, kind)))
        hash.update(chunk);
      return cache.hashes.get(kind) === hash.digest("hex");
    });
  } catch {
    return false;
  }
}

function writeFragment(
  store: ExportStore,
  directory: string,
  kind: PersonalExportKind,
) {
  const hash = createHash("sha256");
  function* chunks() {
    for (const chunk of personalExportKindChunks(store, kind)) {
      hash.update(chunk);
      yield chunk;
    }
  }
  atomicWrite(fragmentPath(directory, kind), chunks());
  return hash.digest("hex");
}

/** Fragments are disposable caches, not backup inputs. Only a completed export
 * earns a reusable cache; a restart, missing/corrupt fragment or any failure
 * rebuilds everything from SQLite on the next attempt. */
export function writePersonalExport(
  store: ExportStore,
  dirty: ReadonlySet<PersonalExportKind>,
) {
  const directory = path.join(store.dataDir, "personal-export-fragments");
  try {
    if (
      lstatSync(store.dataDir).isSymbolicLink() ||
      realpathSync(store.dataDir) !== store.dataDir
    )
      throw Error("Export data directory cannot traverse a symlink");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      lstatSync(directory).isSymbolicLink() ||
      realpathSync(directory) !== directory
    )
      throw Error("Export fragments cannot traverse a symlink");
    const registry = JSON.stringify(personalExportKinds);
    const previous = caches.get(store);
    const reusable = previous && fragmentsIntact(directory, previous, registry);
    const hashes = new Map(reusable ? previous.hashes : undefined);
    for (const kind of personalExportKinds)
      if (!reusable || dirty.has(kind))
        hashes.set(kind, writeFragment(store, directory, kind));
    atomicWrite(
      path.join(store.dataDir, "personal-export.json"),
      personalExportChunks(store, (kind) =>
        readChunks(fragmentPath(directory, kind)),
      ),
    );
    caches.set(store, { registry, hashes });
  } catch (error) {
    caches.delete(store);
    throw error;
  }
}
