import { useState } from "react";
import { tunables } from "../../../shared/tunables";
import type { ActivityArchiveScope, ActivityLevel, ActivityPage } from "../../../shared/activity";
import type { Go } from "../../workspace/workspace-actions";
import { ActivitySelection } from "./ActivitySelection";
import { appendActivity } from "./record-pages";
import { usePagedRecords } from "./usePagedRecords";
import { useRecordSearch } from "./useRecordSearch";

export function ActivityBrowser({ go, pageSize = tunables["records.activityPageSize"].default }: { go: Go; pageSize?: number }) {
  const { query, setQuery, search, pending } = useRecordSearch();
  const [workflow, setWorkflow] = useState("");
  const [level, setLevel] = useState<ActivityLevel | "">("");
  const [archived, setArchived] = useState<ActivityArchiveScope>("active");
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (search) params.set("q", search);
  if (workflow) params.set("workflow", workflow);
  if (level) params.set("level", level);
  if (archived !== "active") params.set("archived", archived);
  const path = `/api/activity?${params}`;
  const { page, loading, error, load, retry, refresh } = usePagedRecords<ActivityPage>(path, appendActivity);
  const workflows = [...new Set([...Object.keys(page?.counts.workflow ?? {}), ...(workflow ? [workflow] : [])])].sort();
  return <div className="records-browser">
    <div className="records-filters">
      <label className="record-search">Find activity<input type="search" placeholder="Message or details…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label>Workflow<select value={workflow} onChange={e => setWorkflow(e.target.value)}>
        <option value="">All workflows</option>{workflows.map(name => <option key={name} value={name}>{name}{page ? ` (${page.counts.workflow[name] ?? 0})` : ""}</option>)}
      </select></label>
      <label>Activity level<select value={level} onChange={e => setLevel(e.target.value as ActivityLevel | "")}>
        <option value="">All levels</option><option value="warning">Warnings and errors</option><option value="error">Errors only</option>
      </select></label>
      <label>Show<select value={archived} onChange={e => setArchived(e.target.value as ActivityArchiveScope)}>
        <option value="active">Not archived</option><option value="archived">Archived</option><option value="all">All activity</option>
      </select></label>
    </div>
    {page && <p className="small">{page.total} activity {page.total === 1 ? "entry" : "entries"} · {page.entries.length} shown</p>}
    {(loading || pending) && <p role="status">{pending ? "Searching activity…" : "Loading activity…"}</p>}
    {error && <div><p role="alert" className="error-text">{error}</p><button type="button" className="button secondary" onClick={retry}>Retry activity</button></div>}
    {page && !page.entries.length && !loading && <p className="muted">No activity matches these filters.</p>}
    {page && <ActivitySelection key={path} page={page} go={go} onChanged={() => void refresh()} />}
    {page?.nextCursor && !error && <button type="button" className="button secondary" disabled={loading || pending}
      onClick={() => void load(page.nextCursor)}>Show more activity</button>}
  </div>;
}
