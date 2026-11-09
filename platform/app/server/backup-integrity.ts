import { readFileSync } from "node:fs";
import {
  readPromotionManifests,
  type PromotionBackupManifest,
} from "./backup-promotions.js";
import { sha256, type Store } from "./storage.js";

export type BackupIntegrity = {
  schemaVersion: 1;
  ok: boolean;
  counts: Record<string, number>;
  referencedObjects: number;
  missingObjects: string[];
  mismatchedObjects: string[];
  unreadableObjects: { id: string; error: string }[];
};

/** Only content-addressed object fields belong here, never evidence fingerprints. */
export function referencedBackupObjects(
  store: Store,
  promotions = readPromotionManifests(store),
): string[] {
  const hashes = new Set<string>();
  const add = (hash: string | undefined) => {
    if (hash !== undefined) hashes.add(hash);
  };
  for (const doc of [
    ...store.list("cache_document"),
    ...store.list("generated_document"),
  ]) {
    add(doc.hash);
    if (doc.sourceHash) add(doc.sourceHash);
  }
  for (const bundle of store.list("bundle"))
    for (const artifact of bundle.artifacts ?? []) add(artifact.hash);
  for (const script of store.list("application_autofill")) {
    add(script.scriptHash);
    add(script.evidenceHash);
    for (const attachment of script.attachments ?? []) add(attachment.hash);
  }
  for (const application of store.list("application"))
    for (const pack of application.packages ?? [])
      for (const doc of pack.documents) add(doc.hash);
  for (const run of store.list("opening_validation_run"))
    for (const result of run.results ?? [])
      for (const hash of result.evidenceHashes ?? []) add(hash);
  for (const manifest of promotions)
    for (const hash of manifest.objectHashes) add(hash);
  return [...hashes].sort();
}

/** A collector retains even corrupt bytes: a partial backup is better than none. */
export function inspectBackupIntegrity(
  store: Store,
  collect?: (id: string, bytes: Uint8Array) => void,
  promotions: PromotionBackupManifest[] = readPromotionManifests(store),
): BackupIntegrity {
  const counts: Record<string, number> = {};
  for (const row of store.db
    .prepare(
      "SELECT kind, COUNT(*) AS count FROM records GROUP BY kind ORDER BY kind",
    )
    .all())
    counts[String(row.kind)] = Number(row.count);
  const hashes = referencedBackupObjects(store, promotions);
  const report: BackupIntegrity = {
    schemaVersion: 1,
    ok: true,
    counts,
    referencedObjects: hashes.length,
    missingObjects: [],
    mismatchedObjects: [],
    unreadableObjects: [],
  };
  for (const id of hashes) {
    try {
      const bytes = readFileSync(store.objectPath(id));
      collect?.(id, bytes);
      if (sha256(bytes) !== id) report.mismatchedObjects.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        report.missingObjects.push(id);
      else report.unreadableObjects.push({ id, error: String(error) });
    }
  }
  report.ok =
    !report.missingObjects.length &&
    !report.mismatchedObjects.length &&
    !report.unreadableObjects.length;
  return report;
}
