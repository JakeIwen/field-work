import { tunables } from "../shared/tunables.js";
import { tunable } from "./tunables.js";
import {
  activityArchiveScopes,
  activityLevels,
  type ActivityEntry,
  type ActivityPage,
  type ActivityQuery,
} from "../shared/activity.js";
import { HttpError, type Store } from "./storage.js";
import { catalogLinks } from "./record-catalog.js";
import { initializeRecordSearch } from "./record-search.js";
import { journalLevelSql, journalWorkflowSql } from "./journal-presentation.js";
import { activityDetails } from "./record-json-preview.js";
import { pageLimit, pageCursor, readPageCursor } from "./record-page-cursor.js";

type JournalRow = Omit<
  ActivityEntry,
  "entity" | "details" | "detailsTruncated" | "archivedAt"
> & {
  archivedAt: string | null;
  entityId: string | null;
  applicationId: string | null;
  recordId: string | null;
  detailApplicationId: string | null;
  detailRecordId: string | null;
  details: string | null;
  detailsCut: number;
  tag: string;
  n: number;
};
const entityColumns = [
  "entityId",
  "applicationId",
  "recordId",
  "detailApplicationId",
  "detailRecordId",
] as const;

function activityEntries(store: Store, rows: JournalRow[]): ActivityEntry[] {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        entityColumns.flatMap((key) => (row[key] ? [row[key]] : [])),
      ),
    ),
  ];
  const byId = new Map(catalogLinks(store, ids).map((link) => [link.id, link]));
  return rows.map((row) => {
    const entity = entityColumns
      .map((key) => (row[key] ? byId.get(row[key]) : undefined))
      .find(Boolean);
    return {
      id: row.id,
      at: row.at,
      type: row.type,
      workflow: row.workflow,
      level: row.level,
      message: row.message,
      ...(entity ? { entity } : {}),
      ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
      ...activityDetails(row.details, Boolean(row.detailsCut)),
    };
  });
}

function readActivity(
  store: Store,
  query: ActivityQuery,
  entities: string[],
  archived: string,
  scope: string,
  limit: number,
) {
  const cursor = readPageCursor(query.cursor, scope);
  const levels = activityLevels.slice(
    query.level === undefined ? 0 : activityLevels.indexOf(query.level),
  );
  const entityClause = entities.length
    ? `(${entityColumns.map((key) => `${key} IN (${entities.map(() => "?").join(",")})`).join(" OR ")})`
    : "1";
  return store.db
    .prepare(
      `WITH journal AS MATERIALIZED (
    SELECT id, COALESCE(json_extract(json,'$.at'),'') AS at, COALESCE(json_extract(json,'$.type'),'') AS type,
      COALESCE(json_extract(json,'$.message'),'') AS message, ${journalWorkflowSql} AS workflow, ${journalLevelSql} AS level,
      json_extract(json,'$.entityId') AS entityId,json_extract(json,'$.applicationId') AS applicationId,json_extract(json,'$.recordId') AS recordId,
      json_extract(json,'$.details.applicationId') AS detailApplicationId,json_extract(json,'$.details.recordId') AS detailRecordId,
      json_extract(json,'$.archivedAt') AS archivedAt,
      CASE WHEN json_type(json,'$.details') IS NULL THEN NULL ELSE json_quote(json_extract(json,'$.details')) END AS details
      FROM records WHERE kind='journal'),
    searched AS MATERIALIZED (SELECT * FROM journal WHERE ${entityClause} AND (?='all' OR (?='archived')=(archivedAt IS NOT NULL)) AND instr(record_lower(message || ' ' || type || ' ' || workflow || ' ' || COALESCE(details,'')),record_lower(?))>0),
    filtered AS MATERIALIZED (SELECT * FROM searched WHERE (?='' OR workflow=?) AND level IN (${levels.map(() => "?").join(",")})),
    page AS (SELECT * FROM filtered WHERE (?='' OR (at,id)<(?,?)) ORDER BY at DESC,id DESC LIMIT ?)
    SELECT 'workflow' AS tag,workflow,count(*) AS n,NULL AS level,NULL AS id,NULL AS at,NULL AS type,NULL AS message,NULL AS entityId,NULL AS applicationId,NULL AS recordId,NULL AS detailApplicationId,NULL AS detailRecordId,NULL AS details,0 AS detailsCut,NULL AS archivedAt FROM searched GROUP BY workflow
    UNION ALL SELECT 'level',NULL,count(*),level,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL FROM searched GROUP BY level
    UNION ALL SELECT 'total',NULL,count(*),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL FROM filtered
    UNION ALL SELECT 'row',workflow,0,level,id,at,type,message,entityId,applicationId,recordId,detailApplicationId,detailRecordId,substr(details,1,8192),length(CAST(details AS BLOB))>8192,archivedAt FROM (SELECT * FROM page ORDER BY at DESC,id DESC)`,
    )
    .all(
      ...entityColumns.flatMap(() => entities),
      archived,
      archived,
      query.q ?? "",
      query.workflow ?? "",
      query.workflow ?? "",
      ...levels,
      cursor ? "yes" : "",
      cursor?.at ?? "",
      cursor?.id ?? "",
      limit + 1,
    ) as JournalRow[];
}

export function activityLog(store: Store, query: ActivityQuery): ActivityPage {
  initializeRecordSearch(store);
  if (query.level !== undefined && !activityLevels.includes(query.level))
    throw new HttpError(400, "Unknown activity level");
  const archived = query.archived ?? "active";
  if (!activityArchiveScopes.includes(archived))
    throw new HttpError(400, "Unknown activity archive scope");
  const limit = pageLimit(
    query.limit,
    tunables["records.activityPageSize"].max,
    tunable(store, "records.activityPageSize"),
  );
  const entities = [...new Set(query.entity ?? [])].sort();
  if (entities.length > 200)
    throw new HttpError(400, "Choose at most 200 activity entities");
  const scope = JSON.stringify([
    query.q ?? "",
    query.workflow ?? "",
    query.level ?? "",
    entities,
    archived,
  ]);
  const results = readActivity(store, query, entities, archived, scope, limit);
  const counts: ActivityPage["counts"] = {
    workflow: {},
    level: { info: 0, warning: 0, error: 0 },
  };
  for (const row of results) {
    if (row.tag === "workflow") counts.workflow[row.workflow] = row.n;
    if (row.tag === "level") counts.level[row.level] = row.n;
  }
  const rows = results.filter((row) => row.tag === "row");
  const entries = activityEntries(store, rows.slice(0, limit));
  const total = results.find((row) => row.tag === "total")?.n ?? 0;
  return {
    entries,
    total,
    counts,
    ...(rows.length > limit
      ? { nextCursor: pageCursor(entries[entries.length - 1], scope) }
      : {}),
  };
}
