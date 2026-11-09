import DeleteRecord from "./DeleteRecord";
import { formatDate } from "./dates";

export function Journal({ entries }: { entries: any[]; }) {
  return entries.length ? (
    <div className="journal">
      {entries.map((e, i) => (
        <div className="journal-entry" key={e.id || i}>{e.id && <DeleteRecord kind="journal" id={e.id} label={e.message || "activity entry"} />}
          <span className="journal-dot" />
          <div>
            <strong>
              {e.message ||
                e.summary ||
                e.action ||
                e.type ||
                "Workspace updated"}
            </strong>
            <small>
              {formatDate(e.at || e.createdAt || e.timestamp, true)}
            </small>
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div className="quiet-empty">
      <p>Your activity will appear here.</p>
    </div>
  );
}
