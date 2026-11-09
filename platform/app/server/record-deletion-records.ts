import { tunableMs } from "./tunables.js";
import { tunables } from "../shared/tunables.js";
import type { DeletionKind } from "../shared/record-deletion.js";
import type { Records } from "./records.js";
import { MissingRecordError, sha256, type Store } from "./storage.js";
import { deletionReferenceScreen } from "./record-deletion-json.js";
import { scanDeletionReferences } from "./record-deletion-references.js";
import { deletionReferenceScrubber } from "./record-deletion-scrub.js";
import {
  deletionHashes,
  deletionHashRetention,
} from "./record-deletion-hashes.js";
import {
  deletionRowKey,
  deletionRowTitle,
  type DeletionRow,
} from "./record-deletion-values.js";
import {
  stateCacheWriteVersion,
  onStateCacheInvalidation,
} from "./storage-state-cache.js";
export { deletionHashes } from "./record-deletion-hashes.js";
export {
  deletionRowKey,
  deletionRowTitle,
  type DeletionRow,
} from "./record-deletion-values.js";
import { samePostingUrls } from "./job-posting.js";

const families: Partial<Record<DeletionKind, (keyof Records)[]>> = {
  company: ["cache_company", "custom_company"],
  opening: ["cache_opening", "custom_opening"],
  document: ["cache_document", "generated_document"],
};

function deletionRows(store: Store): DeletionRow[] {
  // Only relationship fields participate in the cascade. Full bodies are read
  // after selection, not kept for every unrelated transcript or posting.
  const fields = [
    "id",
    "company_id",
    "companyId",
    "openingId",
    "applicationId",
    "taskId",
    "generatedBy",
    "runId",
    "preparationId",
    "entityId",
    "url",
    "documentIds",
    "taskIds",
    "dynamicQuestions",
    "attachments",
    "packages",
    "path",
    "hash",
    "snapshotPath",
  ];
  const projection = fields
    .map((field) => `'${field}',json_extract(json,'$.${field}')`)
    .join(",");
  const sql = `SELECT kind,id,json_object(${projection},'context',json_object(
    'companyId',json_extract(json,'$.context.companyId'),
    'openingId',json_extract(json,'$.context.openingId'),
    'applicationId',json_extract(json,'$.context.applicationId'))) AS json
    FROM records ORDER BY kind,id`;
  return (
    store.db.prepare(sql).all() as {
      kind: keyof Records;
      id: string;
      json: string;
    }[]
  ).map((row) => ({ kind: row.kind, id: row.id, value: JSON.parse(row.json) }));
}

function dependencies(chosen: DeletionRow[]) {
  const ids = (kinds: string[]) =>
    new Set(chosen.filter((r) => kinds.includes(r.kind)).map((r) => r.id));
  return {
    companies: ids(["cache_company", "custom_company"]),
    openings: ids(["cache_opening", "custom_opening"]),
    applications: ids(["application"]),
    tasks: ids(["task"]),
    docs: ids(["cache_document", "generated_document"]),
    pulls: ids(["greenhouse_pull_run"]),
    preparations: ids(["application_preparation"]),
    docTasks: new Set(
      chosen
        .filter((r) =>
          ["cache_document", "generated_document"].includes(r.kind),
        )
        .map((r) => r.value.generatedBy)
        .filter(Boolean),
    ),
    ownedTasks: new Set(
      chosen.flatMap((r) =>
        r.kind === "application_preparation"
          ? (r.value.taskIds ?? [])
          : ["greenhouse_pull_run", "greenhouse_pull_candidate"].includes(
                r.kind,
              )
            ? [r.value.taskId].filter(Boolean)
            : r.kind === "application_autofill"
              ? (r.value.dynamicQuestions ?? [])
                  .map((q: any) => q.taskId)
                  .filter(Boolean)
              : [],
      ),
    ),
    documentIds: new Set(
      chosen
        .filter((r) => r.kind === "application")
        .flatMap((r) => [
          ...(r.value.documentIds ?? []),
          ...(r.value.packages ?? []).flatMap((p: any) =>
            (p.documents ?? []).map((d: any) => d.id),
          ),
        ]),
    ),
  };
}

function belongs(r: DeletionRow, d: ReturnType<typeof dependencies>) {
  const v = r.value;
  return (
    d.companies.has(v.company_id) ||
    d.companies.has(v.companyId) ||
    d.companies.has(v.context?.companyId) ||
    d.openings.has(v.openingId) ||
    d.openings.has(v.context?.openingId) ||
    d.applications.has(v.applicationId) ||
    d.applications.has(v.context?.applicationId) ||
    d.tasks.has(v.taskId) ||
    d.tasks.has(v.generatedBy) ||
    (d.tasks.has(v.id) && ["bundle"].includes(r.kind)) ||
    (r.kind === "task" && (d.docTasks.has(r.id) || d.ownedTasks.has(r.id))) ||
    (["cache_document", "generated_document"].includes(r.kind) &&
      d.documentIds.has(r.id)) ||
    (r.kind === "greenhouse_pull_candidate" && d.pulls.has(v.runId)) ||
    d.preparations.has(v.preparationId) ||
    (["application_preparation", "application_autofill"].includes(r.kind) &&
      ((v.documentIds ?? []).some((id: string) => d.docs.has(id)) ||
        (v.taskIds ?? []).some((id: string) => d.tasks.has(id)) ||
        (v.dynamicQuestions ?? []).some((q: any) => d.tasks.has(q.taskId)) ||
        (v.attachments ?? []).some((a: any) => d.docs.has(a.documentId)))) ||
    (["personal", "company_contact", "opening_validation"].includes(r.kind) &&
      (d.companies.has(r.id) || d.openings.has(r.id) || d.docs.has(r.id))) ||
    (r.kind === "journal" &&
      (d.companies.has(v.entityId) ||
        d.openings.has(v.entityId) ||
        d.applications.has(v.entityId) ||
        d.tasks.has(v.entityId) ||
        d.docs.has(v.entityId)))
  );
}

function selectCascade(all: DeletionRow[], kind: DeletionKind, id: string) {
  const rootKinds = families[kind] ?? [kind as keyof Records];
  const roots = all.filter((r) => rootKinds.includes(r.kind) && r.id === id);
  if (!roots.length)
    throw new MissingRecordError(
      404,
      kind,
      id,
      "Record not found; it may already have been deleted.",
    );
  const selected = new Map(roots.map((r) => [deletionRowKey(r), r]));
  if (kind === "opening")
    for (const r of all) {
      if (
        ["cache_opening", "custom_opening"].includes(r.kind) &&
        roots.some(
          (root) =>
            root.value.url &&
            r.value.url &&
            samePostingUrls(root.value.url, r.value.url),
        )
      )
        selected.set(deletionRowKey(r), r);
    }
  let changed = true;
  while (changed) {
    changed = false;
    const deps = dependencies([...selected.values()]);
    for (const r of all) {
      if (
        selected.has(deletionRowKey(r)) ||
        [
          "deleted_record",
          "settings",
          "meta",
          "reference_context",
          "greenhouse_browser",
        ].includes(r.kind)
      )
        continue;
      if (belongs(r, deps)) {
        selected.set(deletionRowKey(r), r);
        changed = true;
      }
    }
  }
  return {
    roots,
    chosen: [...selected.values()],
    kept: all.filter((r) => !selected.has(deletionRowKey(r))),
  };
}

function referenceScrubber(chosen: DeletionRow[]) {
  const {
    companies: companyIds,
    openings: openingIds,
    docs: documentIds,
    applications: applicationIds,
    tasks: taskIds,
  } = dependencies(chosen);
  const allIds = new Set(chosen.map((r) => r.id));
  const scrub = deletionReferenceScrubber({
    companyIds,
    openingIds,
    documentIds,
    applicationIds,
    allIds,
  });
  return { companyIds, openingIds, taskIds, scrub };
}

function compactDeletionRow(row: DeletionRow): DeletionRow {
  const value = row.value;
  return {
    kind: row.kind,
    id: row.id,
    value: {
      title: deletionRowTitle(row),
      path: value.path,
      hash: value.hash,
      availableInSource: value.availableInSource,
      snapshotPath: value.snapshotPath,
      status: value.status,
    },
  };
}

function scrubImportHashes(
  row: DeletionRow,
  scrub: (value: any) => any,
  documents: DeletionRow[],
) {
  const value = scrub(row.value);
  if (row.kind !== "meta" || !value?.sourceHashes) return value;
  const removed = documents.filter(
    (doc) => value.sourceHashes[doc.value.path] === doc.value.hash,
  );
  if (!removed.length) return value;
  const sourceHashes = { ...value.sourceHashes };
  for (const doc of removed) delete sourceHashes[doc.value.path];
  return { ...value, sourceHashes };
}

function buildRecordPlan(store: Store, kind: DeletionKind, id: string) {
  const selected = selectCascade(deletionRows(store), kind, id);
  const chosen = selected.chosen.map((row) => {
    const value = store.get(row.kind, row.id);
    if (!value)
      throw new MissingRecordError(
        409,
        row.kind,
        row.id,
        "A related record changed; review a fresh deletion preview.",
      );
    return { ...row, value } as DeletionRow;
  });
  for (const row of chosen)
    if (row.kind === "task") row.value.events = store.taskEvents(row.id);
  const objectHashes = new Set(
    chosen.flatMap((row) => deletionHashes(row.value)),
  );
  const needles = chosen.map((row) => row.id);
  // Split Opening identities can contain numeric company/job IDs; the property
  // name screens those without depending on the number's JSON spelling.
  if (
    chosen.some((row) => ["cache_opening", "custom_opening"].includes(row.kind))
  )
    needles.push("company_id");
  const references = referenceScrubber(chosen);
  const retention = deletionHashRetention(objectHashes);
  const documents = chosen.filter((row) => row.kind === "cache_document");
  const updates = scanDeletionReferences(
    store,
    chosen,
    {
      mayReference: deletionReferenceScreen(needles),
      scrub: references.scrub,
      retainHashes: retention.retain,
    },
    (row) => scrubImportHashes(row, references.scrub, documents),
  );
  const recordsToken = sha256(JSON.stringify({ kind, id, chosen, updates }));
  const compact = chosen.map(compactDeletionRow);
  const roots = new Set(selected.roots.map(deletionRowKey));
  // Confirmation needs file ownership and actual edits, not unrelated record bodies
  // or already-fingerprinted histories of records it will remove.
  return {
    roots: compact.filter((row) => roots.has(deletionRowKey(row))),
    chosen: compact,
    kept: selected.kept.filter((row) =>
      ["cache_document", "career_scan"].includes(row.kind),
    ),
    updates,
    objectHashes,
    retainedHashes: retention.retained,
    recordsToken,
    ...references,
  };
}

type RecordPlan = ReturnType<typeof buildRecordPlan>;
export const deletionPreviewLifetimeMs =
  tunables["records.deletionPreviewS"].default * 1000;
const previews = new WeakMap<
  Store,
  {
    identity: string;
    version: string;
    plan: RecordPlan;
    expires: number;
    timer: ReturnType<typeof setTimeout>;
    unsubscribe: () => void;
  }
>();

export function clearDeletionRecordPlan(store: Store) {
  const entry = previews.get(store);
  if (!entry) return;
  previews.delete(store);
  clearTimeout(entry.timer);
  entry.unsubscribe();
}

export function deletionRecordPlan(
  store: Store,
  kind: DeletionKind,
  id: string,
): RecordPlan {
  const identity = JSON.stringify([kind, id]),
    version = stateCacheWriteVersion(store);
  const cached = previews.get(store);
  if (
    cached?.identity === identity &&
    cached.version === version &&
    cached.expires > Date.now()
  )
    return cached.plan;
  clearDeletionRecordPlan(store);
  const plan = buildRecordPlan(store, kind, id);
  const lifetimeMs = tunableMs(store, "records.deletionPreviewS");
  // Never keep a mixed view across an external commit. The timer also releases
  // cancelled dialogs even when no later request or write touches this Store.
  if (stateCacheWriteVersion(store) === version) {
    const timer = setTimeout(() => clearDeletionRecordPlan(store), lifetimeMs);
    timer.unref?.();
    previews.set(store, {
      identity,
      version,
      plan,
      timer,
      expires: Date.now() + lifetimeMs,
      unsubscribe: onStateCacheInvalidation(store, () =>
        clearDeletionRecordPlan(store),
      ),
    });
  }
  return plan;
}
