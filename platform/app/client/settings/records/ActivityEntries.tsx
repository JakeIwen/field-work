import { X } from "lucide-react";
import type { ActivityEntry, ActivityLevel } from "../../../shared/activity";
import { Badge } from "../../ui/Badge";
import { formatDate } from "../../ui/dates";
import type { Go } from "../../workspace/workspace-actions";
import { RecordEntityLink } from "./RecordEntityLink";
import "./records-activity.css";

const levelTones: Record<ActivityLevel, string> = { info: "muted", warning: "amber", error: "red" };
const levelLabels: Record<ActivityLevel, string> = { info: "Info", warning: "Warning", error: "Error" };

type Selection = { ids: ReadonlySet<string>; toggle: (id: string) => void; disabled?: boolean };
type Archiving = { setArchived: (ids: string[], archived: boolean) => void; disabled: boolean };

export function ActivityEntries({ entries, go, selection, archiving }: {
  entries: ActivityEntry[]; go: Go; selection?: Selection; archiving?: Archiving;
}) {
  return <ul className="activity-entries">
    {entries.map(entry => <li key={entry.id} className="activity-entry">
      {selection && <input type="checkbox" className="activity-select" checked={selection.ids.has(entry.id)}
        disabled={selection.disabled} aria-label={`Select activity: ${entry.message}`}
        onChange={() => selection.toggle(entry.id)} />}
      <div className="activity-entry-content">
        <div className="record-metadata"><Badge tone={levelTones[entry.level]}>{levelLabels[entry.level]}</Badge>
          {entry.archivedAt && <Badge tone="muted">Archived</Badge>}
          <span>{entry.workflow}</span><time dateTime={entry.at}>{formatDate(entry.at, true)}</time>
        </div>
        <p className="activity-message">{entry.message}</p>
        {entry.entity && <div className="small"><RecordEntityLink record={entry.entity} go={go} /></div>}
        <details className="activity-details"><summary>Details</summary>
          <p className="small muted">{entry.type}</p>
          {entry.details ? <pre className="record-json">{entry.details}</pre> : <p className="small muted">No additional details saved.</p>}
          {entry.detailsTruncated && <p className="small muted">Long details are abbreviated.</p>}
        </details>
      </div>
      {archiving && (entry.archivedAt
        ? <button type="button" className="text-button activity-archive" disabled={archiving.disabled}
          onClick={() => archiving.setArchived([entry.id], false)}>Restore</button>
        : <button type="button" className="icon-button activity-archive" title="Archive" aria-label={`Archive activity: ${entry.message}`}
          disabled={archiving.disabled} onClick={() => archiving.setArchived([entry.id], true)}><X size={15} aria-hidden="true" /></button>)}
    </li>)}
  </ul>;
}
