import { tunables } from "../shared/tunables.js";
import { tunable } from "./tunables.js";
import {
  catalogKinds,
  catalogSorts,
  type CatalogKind,
  type CatalogPage,
  type CatalogQuery,
  type CatalogRow,
} from "../shared/record-catalog.js";
import { modelRequestLabels } from "../shared/codex-models.js";
import { HttpError, type Store } from "./storage.js";
import { initializeRecordSearch } from "./record-search.js";
import { pageCursor, readPageCursor, pageLimit } from "./record-page-cursor.js";

const field = (name: string) => `NULLIF(json_extract(r.json, '$.${name}'), '')`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const status = `COALESCE(${field("status")}, '')`;
const company = `COALESCE(${field("company")}, json_extract(o.json,'$.company'), json_extract(c.json,'$.company'), '')`;
const role = `COALESCE(json_extract(o.json,'$.title'), json_extract(c.json,'$.title'), ${field("role")}, '')`;
const companyRole = `trim(${company} || CASE WHEN ${company}!='' AND ${role}!='' THEN ' · ' ELSE '' END || ${role})`;
const careerScope = `CASE ${field("mode")} WHEN 'all' THEN 'All monitored companies' WHEN 'failed' THEN 'Failed-company retry' ELSE COALESCE(${field("scope")},${field("mode")},'') END`;
const date = `substr(COALESCE(${field("createdAt")},${field("startedAt")},${field("at")},${field("firstImportedAt")},${field("addedAt")},''),1,10)`;
const purpose = `COALESCE(CASE WHEN json_type(r.json,'$.autofillContext')='object' THEN 'application-answers' WHEN json_type(r.json,'$.greenhousePull')='object' THEN 'greenhouse-pull' END, ${field("purpose")}, ${field("preset")}, '')`;
const purposeLabel = `CASE ${purpose} ${Object.entries(modelRequestLabels)
  .map(([key, label]) => `WHEN ${quote(key)} THEN ${quote(label)}`)
  .join(" ")} ELSE ${purpose} END`;

type CatalogDefinition = {
  storage: readonly string[];
  title: string;
  subtitle: string;
};
/** One table owns storage families and their human-facing projections. Cache rows win, as in deletion. */
export const catalogDefinitions: Record<CatalogKind, CatalogDefinition> = {
  application: {
    storage: ["application"],
    title: `COALESCE(NULLIF(${role},''), ${field("title")}, r.id)`,
    subtitle: company,
  },
  application_autofill: {
    storage: ["application_autofill"],
    title: `COALESCE(NULLIF(${companyRole},''), ${field("title")}, 'Autofill script')`,
    subtitle: `'Created ' || ${date}`,
  },
  application_preparation: {
    storage: ["application_preparation"],
    title: `COALESCE(NULLIF(${companyRole},''), 'Application preparation')`,
    subtitle: status,
  },
  career_scan: {
    storage: ["career_scan"],
    title: `'Careers scan'`,
    subtitle: `${date} || ' · ' || ${careerScope} || ' · ' || ${status}`,
  },
  company: {
    storage: ["cache_company", "custom_company"],
    title: `COALESCE(${field("name")},r.id)`,
    subtitle: `''`,
  },
  document: {
    storage: ["cache_document", "generated_document"],
    title: `COALESCE(${field("name")},${field("path")},r.id)`,
    subtitle: `COALESCE(${field("company")},'')`,
  },
  greenhouse_pull_run: {
    storage: ["greenhouse_pull_run"],
    title: `'Greenhouse pull'`,
    subtitle: `${date} || ' · ' || ${status} || ' · ' || COALESCE(${field("added")},(SELECT added FROM pullCounts WHERE runId=r.id),0) || '/' || COALESCE(${field("target")},0) || ' added'`,
  },
  opening: {
    storage: ["cache_opening", "custom_opening"],
    title: `COALESCE(${field("title")},r.id)`,
    subtitle: company,
  },
  opening_validation_run: {
    storage: ["opening_validation_run"],
    title: `'Availability check'`,
    subtitle: `${date} || ' · ' || ${status} || ' · ' || COALESCE(${field("counts.open")},0) || ' open, ' || COALESCE(${field("counts.closed")},0) || ' closed, ' || COALESCE(${field("counts.unknown")},0) || ' unknown'`,
  },
  task: {
    storage: ["task"],
    title: `COALESCE(${field("title")},'Agent task')`,
    subtitle: `${purposeLabel} || ' · ' || ${status} || CASE WHEN ${companyRole}!='' THEN ' · ' || ${companyRole} ELSE '' END`,
  },
};

export function isCatalogKind(value: string): value is CatalogKind {
  return Object.hasOwn(catalogDefinitions, value);
}

export const catalogStorageKinds = catalogKinds.flatMap(
  (kind) => catalogDefinitions[kind].storage,
);
const kindCase = (property: "title" | "subtitle") =>
  `CASE ${catalogKinds.map((kind) => `WHEN r.kind IN (${catalogDefinitions[kind].storage.map(quote)}) THEN ${catalogDefinitions[kind][property]}`).join(" ")} END`;
const catalogKindSql = `CASE ${catalogKinds.map((kind) => `WHEN r.kind IN (${catalogDefinitions[kind].storage.map(quote)}) THEN ${quote(kind)}`).join(" ")} END`;
const dedupeSql = catalogKinds
  .flatMap((kind) => {
    const [first, second] = catalogDefinitions[kind].storage;
    return second
      ? [
          `(r.kind!=${quote(second)} OR NOT EXISTS(SELECT 1 FROM records peer WHERE peer.kind=${quote(first)} AND peer.id=r.id))`,
        ]
      : [];
  })
  .join(" AND ");

/** The optional predicate constrains exact lookups before SQLite extracts any payload fields. */
export function catalogSelect(predicate = "1") {
  return `WITH pullCounts AS MATERIALIZED (
      SELECT json_extract(json,'$.runId') AS runId, count(*) AS added FROM records
      WHERE kind='greenhouse_pull_candidate' AND json_extract(json,'$.state')='added'
      GROUP BY json_extract(json,'$.runId'))
    SELECT ${catalogKindSql} AS kind, r.kind AS storageKind, r.id,
    substr(${kindCase("title")},1,300) AS title, substr(${kindCase("subtitle")},1,600) AS subtitle,
    ${status} AS status,
    COALESCE(${field("createdAt")},${field("startedAt")},${field("at")},${field("firstImportedAt")},${field("addedAt")},'') AS at,
    CASE WHEN ${field("createdAt")} IS NOT NULL THEN 'Created' WHEN ${field("startedAt")} IS NOT NULL THEN 'Started' WHEN ${field("at")} IS NOT NULL THEN 'Created' WHEN COALESCE(${field("firstImportedAt")},${field("addedAt")}) IS NOT NULL THEN 'Added' END AS atLabel,
    length(CAST(r.json AS BLOB)) AS bytes, ${company} AS company, ${role} AS role
    FROM records r
    LEFT JOIN records o ON o.kind='cache_opening' AND o.id=COALESCE(${field("openingId")},${field("context.openingId")},${field("autofillContext.openingId")})
    LEFT JOIN records c ON c.kind='custom_opening' AND c.id=COALESCE(${field("openingId")},${field("context.openingId")},${field("autofillContext.openingId")})
    WHERE r.kind IN (${catalogStorageKinds.map(quote)}) AND ${dedupeSql} AND (${predicate})`;
}

export type CatalogProjection = CatalogRow & {
  storageKind: string;
  company: string;
  role: string;
};
export function catalogRow(row: CatalogProjection): CatalogRow {
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    bytes: row.bytes,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.at ? { at: row.at, atLabel: row.atLabel } : {}),
  };
}

export function catalogRecords(store: Store, query: CatalogQuery): CatalogPage {
  initializeRecordSearch(store);
  if (query.kind !== undefined && !isCatalogKind(query.kind))
    throw new HttpError(400, "Unknown record kind");
  const sort = query.sort ?? "newest";
  if (!catalogSorts.includes(sort))
    throw new HttpError(400, "Unknown record sort");
  const limit = pageLimit(
    query.limit,
    tunables["records.catalogPageSize"].max,
    tunable(store, "records.catalogPageSize"),
  );
  const scope = JSON.stringify([query.kind ?? "", query.q ?? "", sort]);
  const cursor = readPageCursor(query.cursor, scope);
  const direction = sort === "newest" ? "DESC" : "ASC";
  const comparison = sort === "newest" ? "<" : ">";
  // Counts and rows share one materialized scalar projection; no task/posting/package reaches Node.
  const result = store.db
    .prepare(
      `WITH catalog AS MATERIALIZED (${catalogSelect()}),
    searched AS MATERIALIZED (SELECT * FROM catalog WHERE instr(record_lower(title || ' ' || subtitle || ' ' || company || ' ' || role || ' ' || id),record_lower(?))>0),
    page AS (SELECT * FROM searched WHERE (?='' OR kind=?) AND (?='' OR (at,id,kind) ${comparison} (?,?,?)) ORDER BY at ${direction}, id ${direction}, kind ${direction} LIMIT ?)
    SELECT 'count' AS tag, kind, count(*) AS n, NULL AS id, NULL AS title, NULL AS subtitle, NULL AS status, NULL AS at, NULL AS atLabel, NULL AS bytes FROM searched GROUP BY kind
    UNION ALL SELECT 'row',kind,0,id,title,subtitle,status,at,atLabel,bytes FROM (SELECT * FROM page ORDER BY at ${direction},id ${direction},kind ${direction})`,
    )
    .all(
      query.q ?? "",
      query.kind ?? "",
      query.kind ?? "",
      cursor ? "yes" : "",
      cursor?.at ?? "",
      cursor?.id ?? "",
      cursor?.kind ?? "",
      limit + 1,
    ) as (CatalogProjection & { tag: string; n: number })[];
  const counts: CatalogPage["counts"] = {};
  for (const row of result.filter((row) => row.tag === "count"))
    counts[row.kind] = row.n;
  const rows = result.filter((row) => row.tag === "row");
  const visible = rows.slice(0, limit).map(catalogRow);
  return {
    rows: visible,
    total: query.kind
      ? (counts[query.kind] ?? 0)
      : Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    ...(rows.length > limit
      ? { nextCursor: pageCursor(visible[visible.length - 1], scope) }
      : {}),
  };
}

export function catalogLinks(store: Store, ids: string[]) {
  if (!ids.length) return [];
  return (
    store.db
      .prepare(catalogSelect(`r.id IN (${ids.map(() => "?").join(",")})`))
      .all(...ids) as CatalogProjection[]
  ).map((row) => ({ kind: row.kind, id: row.id, title: row.title }));
}
