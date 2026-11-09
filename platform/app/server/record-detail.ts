import type {
  CatalogKind,
  RecordDetail,
  RecordField,
} from "../shared/record-catalog.js";
import { MissingRecordError, type Store } from "./storage.js";
import {
  catalogDefinitions,
  catalogSelect,
  catalogRow,
  isCatalogKind,
  type CatalogProjection,
} from "./record-catalog.js";
import { activityLog } from "./activity-log.js";
import { recordJsonPreview } from "./record-json-preview.js";
import { relatedRecords } from "./record-relations.js";

type FieldSpec = readonly [label: string, path: string];
const commonFields: FieldSpec[] = [
  ["Status", "status"],
  ["Created", "createdAt"],
  ["Started", "startedAt"],
  ["Updated", "updatedAt"],
  ["Completed", "completedAt"],
  ["Added", "firstImportedAt"],
  ["Added", "addedAt"],
  ["Version", "version"],
  ["Error", "error"],
];
const detailFields: Record<CatalogKind, FieldSpec[]> = {
  application: [
    ["Application date", "applicationDate"],
    ["Submitted", "submittedAt"],
    ["Next action", "nextAction"],
    ["Follow-up", "followUp"],
  ],
  application_autofill: [
    ["Provider", "provider"],
    ["Copied", "copiedAt"],
    ["URL", "url"],
  ],
  application_preparation: [
    ["Phase", "phase"],
    ["Progress", "message"],
    ["Documents", "documentIds"],
    ["Tasks", "taskIds"],
  ],
  career_scan: [
    ["Scope", "scope"],
    ["Mode", "mode"],
    ["Summary", "summary"],
    ["Companies", "companies"],
    ["Completed companies", "completed"],
    ["Total companies", "total"],
  ],
  company: [
    ["Name", "name"],
    ["Careers URL", "careers_url"],
  ],
  document: [
    ["File", "name"],
    ["Path", "path"],
    ["Kind", "kind"],
    ["Privacy", "privacy"],
    ["Format", "format"],
  ],
  greenhouse_pull_run: [
    ["Target", "target"],
    ["Added", "added"],
    ["Phase", "phase"],
    ["Pages", "pages"],
    ["Finished", "finishedAt"],
  ],
  opening: [
    ["Location", "location"],
    ["URL", "url"],
    ["Availability", "postingStatus"],
  ],
  opening_validation_run: [
    ["Total", "total"],
    ["Completed openings", "completed"],
    ["Counts", "counts"],
    ["Visibility changes", "visibilityChanges"],
  ],
  task: [
    ["Preset", "preset"],
    ["Purpose", "purpose"],
    ["Events", "eventCount"],
  ],
};

function readableFields(store: Store, row: CatalogProjection): RecordField[] {
  const specs = [...commonFields, ...detailFields[row.kind]];
  const expressions = specs.map(
    ([, path], index) =>
      `CASE WHEN json_type(json,'$.${path}')='array' THEN json_array_length(json,'$.${path}') || ' items' ELSE substr(CAST(json_extract(json,'$.${path}') AS TEXT),1,2000) END AS f${index}`,
  );
  const summary = store.db
    .prepare(
      `SELECT ${expressions.join(",")} FROM records WHERE kind=? AND id=?`,
    )
    .get(row.storageKind, row.id);
  const fields = specs.flatMap(([label], index) => {
    const value = summary?.[`f${index}`];
    return value === null || value === undefined || value === ""
      ? []
      : [{ label, value: String(value) }];
  });
  if (row.kind === "greenhouse_pull_run" && row.subtitle)
    fields.push({ label: "Progress", value: row.subtitle });
  if (row.company) fields.unshift({ label: "Company", value: row.company });
  if (row.role || row.kind === "opening")
    fields.unshift({ label: "Role", value: row.role || row.title });
  return fields;
}

export function recordDetail(
  store: Store,
  kind: string,
  id: string,
): RecordDetail {
  if (!isCatalogKind(kind))
    throw new MissingRecordError(404, kind, id, "Record kind not found");
  const storage = catalogDefinitions[kind].storage;
  const row = store.db
    .prepare(catalogSelect(`r.id=? AND r.kind IN (${storage.map(() => "?")})`))
    .get(id, ...storage) as CatalogProjection | undefined;
  if (!row) throw new MissingRecordError(404, kind, id, "Record not found");
  const preview = recordJsonPreview(store, row.storageKind, id);
  return {
    row: catalogRow(row),
    fields: readableFields(store, row),
    ...relatedRecords(store, row),
    activity: activityLog(store, { entity: [id], archived: "all", limit: 20 })
      .entries,
    raw: preview.text,
    rawTruncated: preview.truncated,
  };
}
