import { readFileSync } from "node:fs";
import {
  atomicWrite,
  safeSource,
  sha256,
  type Store,
} from "../../server/storage.js";
import { applicationEvidencePaths } from "../../server/application-evidence.js";
import { documentOpeningHash } from "../../server/preparation-documents.js";
import type { Bundle, Task } from "../../shared/task-records.js";
import { legacyBundle, legacyDocument } from "./legacy-records.js";

export function fixtureEvidenceHashes(
  store: Store,
  paths: readonly string[] = applicationEvidencePaths,
) {
  return Object.fromEntries(
    paths.map((file) => [
      file,
      sha256(readFileSync(safeSource(store.root, file))),
    ]),
  );
}

export function saveFixturePdf(
  store: Store,
  document: Parameters<typeof legacyDocument>[0],
  bytes: Uint8Array,
  source?: string,
) {
  const hash = sha256(bytes);
  atomicWrite(store.objectPath(hash), bytes);
  const sourceHash = source === undefined ? undefined : sha256(source);
  if (sourceHash && source !== undefined)
    atomicWrite(store.objectPath(sourceHash), source);
  const saved = legacyDocument({
    format: "pdf",
    privacy: "private",
    name: `${document?.kind}.pdf`,
    validation: "passed",
    ...document,
    hash,
    ...(sourceHash ? { sourceHash } : {}),
  });
  store.put("generated_document", saved.id, saved);
  return saved;
}

export function saveCompletedDocumentTask(
  store: Store,
  task: Task,
  openingId: string,
  ids: string[],
  bundle: Partial<Bundle>,
  postingHash?: string,
) {
  return store.put("task", task.id, {
    ...task,
    status: "completed",
    context: { openingId },
    documentResult: { status: "ready", documentIds: ids },
    preparationOpeningHash: documentOpeningHash(store.opening(openingId)),
    ...(postingHash ? { preparationPostingHash: postingHash } : {}),
    bundle: legacyBundle(bundle),
  });
}
