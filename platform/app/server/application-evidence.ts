import { readFileSync } from "node:fs";
import { safeSource, sha256, type Store } from "./storage.js";

// Instructions and rendering code remain provenance for future generation;
// factual validity is checked here; document writing freshness is checked separately.
import {
  currentResumePath,
  evidenceDossierPath,
} from "../shared/workspace-sources.js";
export {
  currentResumePath,
  evidenceDossierPath,
} from "../shared/workspace-sources.js";
export const applicationEvidencePaths = [
  currentResumePath,
  evidenceDossierPath,
];

export const applicationSourceNeedsRefresh = (relative: string) =>
  applicationEvidencePaths.includes(relative) ||
  /^source_master_template\/.*\.swift$/.test(relative);
const legacyPaths = [
  "AGENTS.md",
  "source_data/README.md",
  ...applicationEvidencePaths,
];

function sourceFingerprint(
  paths: string[],
  hashes: Record<string, string> | undefined,
) {
  if (!hashes || paths.some((p) => !hashes[p])) return undefined;
  return sha256(JSON.stringify(paths.map((p) => [p, hashes[p]])));
}

export function applicationEvidenceHash(hashes?: Record<string, string>) {
  return sourceFingerprint(applicationEvidencePaths, hashes);
}

function readSourceHashes(store: Store, paths: string[]) {
  return Object.fromEntries(
    paths.map((p) => [p, sha256(readFileSync(safeSource(store.root, p)))]),
  );
}

export function answerKnowledgeHash(store: Store) {
  return sha256(
    JSON.stringify(
      applicationEvidencePaths.map((p) => [
        p,
        sha256(readFileSync(safeSource(store.root, p))),
      ]),
    ),
  );
}

export function currentApplicationKnowledgeHashes(store: Store) {
  const current = answerKnowledgeHash(store);
  const accepted = new Set([current]);
  const snapshots = [
    ...store.list("application_answer_set").map((r) => r.sourceHashes),
    ...store.list("bundle").map((r) => r.sourceHashes),
    ...taskSourceHashes(store),
  ];
  try {
    snapshots.push(readSourceHashes(store, legacyPaths));
  } catch {
    // Missing developer instructions cannot invalidate saved artifacts.
  }
  // Recover old four-file fingerprints from their captured evidence without
  // rewriting historical records or trusting a hash with no matching snapshot.
  for (const snapshot of snapshots) {
    if (applicationEvidenceHash(snapshot) !== current) continue;
    const legacy = sourceFingerprint(legacyPaths, snapshot);
    if (legacy) accepted.add(legacy);
  }
  return accepted;
}

function taskSourceHashes(store: Store) {
  const rows = store.db
    .prepare(
      `SELECT json_extract(json, '$.manifest.sourceHashes') AS manifest,
    json_extract(json, '$.bundle.sourceHashes') AS bundle FROM records WHERE kind='task'`,
    )
    .all();
  return rows.flatMap((row) =>
    [row.manifest, row.bundle].map((value) =>
      typeof value === "string"
        ? (JSON.parse(value) as Record<string, string>)
        : undefined,
    ),
  );
}
