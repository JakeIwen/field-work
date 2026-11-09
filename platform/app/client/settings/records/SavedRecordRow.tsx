import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CatalogRow } from "../../../shared/record-catalog";
import { Badge } from "../../ui/Badge";
import DeleteRecord from "../../ui/DeleteRecord";
import { formatDate } from "../../ui/dates";
import type { Go } from "../../workspace/workspace-actions";
import { RecordData } from "./RecordData";
import { catalogLabels, recordSize } from "./record-pages";

export function SavedRecordRow({ row, go, onDeleted }: { row: CatalogRow; go: Go; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return <li className="saved-record">
    <div className="saved-record-heading">
      <button type="button" className="text-button saved-record-toggle" aria-label={`Details for ${row.title}`}
        aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="saved-record-label"><strong>{row.title}</strong>{row.subtitle && <span className="muted">{row.subtitle}</span>}</span>
      </button>
      <DeleteRecord kind={row.kind} id={row.id} label={row.title} onDeleted={onDeleted} />
    </div>
    <div className="record-metadata"><span>{catalogLabels[row.kind]}</span>
      {row.status && <Badge>{row.status}</Badge>}
      {row.at && <span>{row.atLabel} <time dateTime={row.at}>{formatDate(row.at, true)}</time></span>}
      <span>{recordSize(row.bytes)}</span>
    </div>
    <div id={detailId} hidden={!open}>{open && <RecordData row={row} go={go} />}</div>
  </li>;
}
