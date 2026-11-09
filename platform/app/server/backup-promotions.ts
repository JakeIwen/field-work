import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Store } from "./storage.js";

export type PromotionBackupManifest = {
  name: string;
  bytes: Uint8Array;
  objectHashes: string[];
};

function capturedHashes(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object")
    throw new Error("Invalid promotion manifest");
  const value = manifest as Record<string, unknown>;
  const hashes: string[] = [];
  for (const [field, hashField] of [
    ["updates", "previousHash"],
    ["validationArtifacts", "hash"],
  ]) {
    const entries = value[field] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Invalid promotion ${field}`);
    for (const entry of entries) {
      const hash =
        entry && typeof entry === "object" ? entry[hashField] : undefined;
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error(`Invalid promotion ${field}.${hashField}`);
      hashes.push(hash);
    }
  }
  // files[].hash, updates[].hash and sourceHashes are source fingerprints.
  // Promotion captures rollback bytes; validation captures its input artifacts.
  return hashes;
}

export function readPromotionManifests(
  store: Pick<Store, "dataDir">,
): PromotionBackupManifest[] {
  const directory = path.join(store.dataDir, "promotions");
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink())
    return [];
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (!name.endsWith(".json") || stat.isSymbolicLink() || !stat.isFile())
        return [];
      const bytes = readFileSync(file);
      return [
        {
          name,
          bytes,
          objectHashes: capturedHashes(JSON.parse(bytes.toString("utf8"))),
        },
      ];
    });
}
