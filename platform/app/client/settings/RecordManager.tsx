import { useState } from "react";
import { tunables } from "../../shared/tunables";
import { catalogKinds, type CatalogKind, type CatalogPage, type CatalogSort } from "../../shared/record-catalog";
import type { Go } from "../workspace/workspace-actions";
import { SavedRecordRow } from "./records/SavedRecordRow";
import { appendCatalog, catalogLabels } from "./records/record-pages";
import { usePagedRecords } from "./records/usePagedRecords";
import { useRecordSearch } from "./records/useRecordSearch";

export default function RecordManager({ go, pageSize = tunables["records.catalogPageSize"].default }: { go: Go; pageSize?: number }) {
  const { query, setQuery, search, pending } = useRecordSearch();
  const [kind, setKind] = useState<CatalogKind | "">("");
  const [sort, setSort] = useState<CatalogSort>("newest");
  const params = new URLSearchParams({ sort, limit: String(pageSize) });
  if (search) params.set("q", search);
  if (kind) params.set("kind", kind);
  const path = `/api/records?${params}`;
  const { page, loading, error, load, retry, refresh } = usePagedRecords<CatalogPage>(path, appendCatalog);
  return <div className="records-browser">
    <div className="records-filters">
      <label className="record-search">Find saved records<input type="search" placeholder="Company, role, title or ID…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Record type<select value={kind} onChange={e => setKind(e.target.value as CatalogKind | "")}>
        <option value="">All record types</option>{catalogKinds.map(value => <option key={value} value={value}>
          {catalogLabels[value]}{page ? ` (${page.counts[value] ?? 0})` : ""}
        </option>)}
      </select></label>
      <label>Sort records<select value={sort} onChange={e => setSort(e.target.value as CatalogSort)}>
        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
      </select></label>
    </div>
    {page && <p className="small">{page.total} {page.total === 1 ? "record" : "records"} · {page.rows.length} shown</p>}
    {(loading || pending) && <p role="status">{pending ? "Searching records…" : "Loading records…"}</p>}
    {error && <div><p role="alert" className="error-text">{error}</p><button type="button" className="button secondary" onClick={retry}>Retry records</button></div>}
    {page && !page.rows.length && !loading && <p className="muted">No saved records match these filters.</p>}
    <ul className="saved-records">{page?.rows.map(row => <SavedRecordRow key={`${path}:${row.kind}:${row.id}`} row={row} go={go}
      onDeleted={() => void refresh()} />)}</ul>
    {page?.nextCursor && !error && <button type="button" className="button secondary" disabled={loading || pending}
      onClick={() => void load(page.nextCursor)}>Show more records</button>}
  </div>;
}
