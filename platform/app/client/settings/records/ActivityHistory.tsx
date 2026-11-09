import { tunables } from "../../../shared/tunables";
import type { ActivityPage } from "../../../shared/activity";
import type { Go } from "../../workspace/workspace-actions";
import { ActivityEntries } from "./ActivityEntries";
import { appendActivity } from "./record-pages";
import { usePagedRecords } from "./usePagedRecords";

export function ActivityHistory({ entityId, go, pageSize = tunables["records.activityPageSize"].default }: { entityId: string; go: Go; pageSize?: number }) {
  const path = `/api/activity?${new URLSearchParams({ entity: entityId, archived: "all", limit: String(pageSize) })}`;
  const { page, loading, error, load, retry } = usePagedRecords<ActivityPage>(path, appendActivity);
  return <div className="activity-history">
    {page && <p className="small muted">{page.total} activity {page.total === 1 ? "entry" : "entries"}</p>}
    {loading && <p role="status">Loading history…</p>}
    {error && <div><p role="alert" className="error-text">{error}</p>
      <button type="button" className="button secondary" onClick={retry}>Retry history</button></div>}
    {page && !page.entries.length && <p className="small muted">No activity saved for this application.</p>}
    {page && <ActivityEntries entries={page.entries} go={go} />}
    {page?.nextCursor && !error && <button type="button" className="button secondary" disabled={loading}
      onClick={() => void load(page.nextCursor)}>Show more history</button>}
  </div>;
}
