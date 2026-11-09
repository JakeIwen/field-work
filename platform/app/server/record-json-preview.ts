import type { Store } from "./storage.js";

const heavyKeys = [
  "posting",
  "postingText",
  "postingBody",
  "requirements",
  "text",
  "html",
  "script",
  "scriptBody",
  "source",
  "base64",
  "pdfBase64",
  "bytes",
  "data",
  "events",
  "thread",
  "profileSnapshot",
];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
type PreviewNode = {
  path: string;
  parent: string | null;
  key: string | number | null;
  type: string;
  value: string | number | null;
  cut: number;
};

/** Walk in SQLite so elided posting/script/PDF values never cross into the Node heap. */
export function recordJsonPreview(store: Store, kind: string, id: string) {
  const nodes = store.db
    .prepare(
      `WITH RECURSIVE nodes(path,parent,key,type,value,cut,depth) AS (
    SELECT '$',NULL,NULL,'object',json,0,0 FROM records WHERE kind=? AND id=?
    UNION ALL SELECT n.path || '/' || length(CAST(e.key AS TEXT)) || ':' || e.key,n.path,e.key,e.type,
      CASE WHEN e.key IN (${heavyKeys.map(quote)}) THEN '[elided heavy field]'
        WHEN e.type='array' AND json_array_length(CASE WHEN e.type='array' THEN e.value ELSE '[]' END)>30 THEN '[elided ' || json_array_length(CASE WHEN e.type='array' THEN e.value ELSE '[]' END) || ' items]'
        WHEN n.depth>=6 AND e.type IN ('array','object') THEN '[elided nested value]'
        WHEN e.type='text' AND length(e.value)>2000 THEN substr(e.value,1,2000) || '… [truncated]'
        ELSE e.value END,
      CASE WHEN e.key IN (${heavyKeys.map(quote)}) OR (e.type='array' AND json_array_length(CASE WHEN e.type='array' THEN e.value ELSE '[]' END)>30) OR (n.depth>=6 AND e.type IN ('array','object')) OR (e.type='text' AND length(e.value)>2000) THEN 1 ELSE 0 END,
      n.depth+1 FROM nodes n, json_each(n.value) e WHERE n.type IN ('array','object') AND n.cut=0
    LIMIT 1001)
    SELECT path,parent,key,type,CASE WHEN type IN ('array','object') AND cut=0 THEN NULL ELSE value END AS value,cut FROM nodes`,
    )
    .all(kind, id) as PreviewNode[];
  const containers = new Map<string, Record<string, unknown> | unknown[]>();
  const root: Record<string, unknown> = {};
  containers.set("$", root);
  let truncated = nodes.length >= 1001;
  for (const node of nodes.slice(1, 1000)) {
    const parent =
      node.parent === null ? undefined : containers.get(node.parent);
    if (!parent || node.key === null) continue;
    truncated ||= Boolean(node.cut);
    const value = node.cut
      ? node.value
      : node.type === "object"
        ? {}
        : node.type === "array"
          ? []
          : node.type === "true"
            ? true
            : node.type === "false"
              ? false
              : node.value;
    // defineProperty also treats a stored __proto__ as data, never as a prototype setter.
    Object.defineProperty(parent, node.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    if (!node.cut && value && typeof value === "object")
      containers.set(node.path, value as Record<string, unknown> | unknown[]);
  }
  return boundedPrettyJson(root, 64 * 1024, truncated);
}

export function boundedPrettyJson(
  value: unknown,
  maximum: number,
  truncated = false,
): { text: string; truncated: boolean } {
  let text = JSON.stringify(value, null, 2) ?? "null";
  if (Buffer.byteLength(text) <= maximum) return { text, truncated };
  // A JSON string preview remains valid JSON even if the cut lands inside an escaped value.
  let preview = text.slice(0, Math.floor(maximum / 2));
  do {
    text = JSON.stringify(
      { preview, note: "Remaining details elided" },
      null,
      2,
    );
    if (Buffer.byteLength(text) <= maximum) break;
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
  } while (preview.length);
  return { text, truncated: true };
}

export function activityDetails(value: string | null, cut: boolean) {
  if (value === null) return {};
  let details: unknown;
  try {
    details = cut
      ? { preview: value, note: "Remaining details elided" }
      : JSON.parse(value);
  } catch {
    details = value;
  }
  const result = boundedPrettyJson(details, 8 * 1024, cut);
  return { details: result.text, detailsTruncated: result.truncated };
}
