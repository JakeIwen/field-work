import { tunable } from "./tunables.js";
import type { RecordDetail, RecordLink } from "../shared/record-catalog.js";
import type { Store } from "./storage.js";
import {
  catalogDefinitions,
  catalogSelect,
  type CatalogProjection,
} from "./record-catalog.js";

const scalarReferences = [
  "openingId",
  "applicationId",
  "taskId",
  "answerTaskId",
  "generatedBy",
  "scriptId",
  "autofillId",
  "preparationId",
  "company_id",
  "companyId",
  "context.openingId",
  "context.companyId",
  "context.applicationId",
  "autofillContext.openingId",
  "greenhousePull.runId",
  "draft.applicationId",
  "pending.applicationId",
];
const arrayReferences = [
  "documentIds",
  "taskIds",
  "context.documentIds",
  "replaceDocumentIds",
];
const forwardKeys = [
  ...new Set([
    ...scalarReferences.map((path) => path.slice(path.lastIndexOf(".") + 1)),
    "documentId",
    "runId",
  ]),
];
const reverseKinds: Record<
  CatalogProjection["kind"],
  CatalogProjection["kind"][]
> = {
  application: ["application_preparation", "application_autofill", "document"],
  application_autofill: ["application", "application_preparation"],
  application_preparation: ["application_autofill"],
  career_scan: [],
  company: ["opening", "task", "document", "career_scan"],
  document: [
    "application",
    "application_autofill",
    "application_preparation",
    "task",
  ],
  greenhouse_pull_run: ["task"],
  opening: [
    "application",
    "application_autofill",
    "application_preparation",
    "task",
    "document",
    "opening_validation_run",
  ],
  opening_validation_run: [],
  task: ["application_preparation", "application_autofill", "document"],
};
const reverseReferences = [
  ...scalarReferences.map(
    (path) => `json_extract(r.json,'$.${path}')=:sourceId`,
  ),
  ...arrayReferences.map(
    (path) =>
      `EXISTS(SELECT 1 FROM json_each(r.json,'$.${path}') ref WHERE ref.value=:sourceId)`,
  ),
  `EXISTS(SELECT 1 FROM json_each(r.json,'$.packages') pack WHERE json_extract(pack.value,'$.scriptId')=:sourceId OR EXISTS(SELECT 1 FROM json_each(pack.value,'$.documentIds') doc WHERE doc.value=:sourceId) OR EXISTS(SELECT 1 FROM json_each(pack.value,'$.documents') doc WHERE json_extract(doc.value,'$.id')=:sourceId))`,
  `EXISTS(SELECT 1 FROM json_each(r.json,'$.attachments') attachment WHERE json_extract(attachment.value,'$.documentId')=:sourceId)`,
  `EXISTS(SELECT 1 FROM json_each(r.json,'$.companies') company WHERE json_extract(company.value,'$.id')=:sourceId)`,
  `EXISTS(SELECT 1 FROM json_each(r.json,'$.targets') target WHERE json_extract(target.value,'$.id')=:sourceId)`,
];

export function relatedRecords(
  store: Store,
  row: CatalogProjection,
): Pick<RecordDetail, "related" | "relatedTotal"> {
  // Restrict reverse reads to families that store these links; unrelated large tasks are not parsed.
  const storageKinds = reverseKinds[row.kind].flatMap(
    (kind) => catalogDefinitions[kind].storage,
  );
  const reversePredicate = storageKinds.length
    ? `r.kind IN (${storageKinds.map((kind) => `'${kind}'`).join(",")}) AND (${reverseReferences.join(" OR ")})`
    : "0";
  // Direct references outrank reverse links, then newest wins; id/kind break equal-date ties deterministically.
  const rows = store.db
    .prepare(
      `WITH forward_ids AS MATERIALIZED (
      SELECT DISTINCT CAST(atom AS TEXT) AS id FROM json_tree((SELECT json FROM records WHERE kind=:sourceKind AND id=:sourceId))
      WHERE type='text' AND (key IN (${forwardKeys.map((key) => `'${key}'`).join(",")}) OR path LIKE '%.documentIds' OR path LIKE '%.taskIds' OR path LIKE '%.replaceDocumentIds' OR (key='id' AND (path LIKE '%.documents[%]' OR path LIKE '%.companies[%]' OR path LIKE '%.targets[%]')))),
    forward_records AS (${catalogSelect("r.id IN (SELECT id FROM forward_ids)")}),
    reverse_records AS (${catalogSelect(reversePredicate)}),
    candidates AS (
      SELECT kind,id,title,at,0 AS priority FROM forward_records
      UNION ALL SELECT kind,id,title,at,1 AS priority FROM reverse_records),
    related AS MATERIALIZED (
      SELECT kind,id,max(title) AS title,max(at) AS at,min(priority) AS priority FROM candidates
      WHERE NOT (kind=:catalogKind AND id=:sourceId) GROUP BY kind,id)
    SELECT kind,id,title,count(*) OVER() AS total FROM related
    ORDER BY priority,at DESC,id DESC,kind LIMIT :limit`,
    )
    .all({
      sourceKind: row.storageKind,
      sourceId: row.id,
      catalogKind: row.kind,
      limit: tunable(store, "records.relatedCap"),
    }) as (RecordLink & { total: number })[];
  return {
    related: rows.map(({ kind, id, title }) => ({ kind, id, title })),
    relatedTotal: rows[0]?.total ?? 0,
  };
}
