import { useEffect, useState } from "react";
import type { CatalogRow, RecordDetail } from "../../../shared/record-catalog";
import { Field } from "../../ui/Field";
import { api } from "../../workspace/api";
import { entityUrl } from "../../shell/entity-url";
import type { Go } from "../../workspace/workspace-actions";
import { ActivityEntries } from "./ActivityEntries";
import { RecordEntityLink } from "./RecordEntityLink";

export function RecordData({ row, go }: { row: CatalogRow; go: Go }) {
  const [detail, setDetail] = useState<RecordDetail>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(""); setDetail(undefined);
    api<RecordDetail>(entityUrl(`/api/records/${encodeURIComponent(row.kind)}`, row.id))
      .then(result => { if (live) setDetail(result); })
      .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [row.kind, row.id, attempt]);
  if (error) return <div><p role="alert" className="error-text">{error}</p>
    <button type="button" className="button secondary" onClick={() => setAttempt(attempt + 1)}>Retry record details</button></div>;
  if (!detail) return <p role="status">Loading record details…</p>;
  return <div className="record-data">
    <div className="record-fields">{detail.fields.map((field, i) => <Field key={`${field.label}:${i}`} label={field.label}>{field.value}</Field>)}</div>
    {!!detail.related.length && <div><h4>Related records</h4>
      {detail.relatedTotal > detail.related.length && <p className="small muted">Showing {detail.related.length} of {detail.relatedTotal} related records</p>}
      <ul className="record-related">
      {detail.related.map(record => <li key={`${record.kind}:${record.id}`}><RecordEntityLink record={record} go={go} /></li>)}
    </ul></div>}
    <div><h4>Recent activity</h4>{detail.activity.length ? <ActivityEntries entries={detail.activity} go={go} />
      : <p className="small muted">No activity saved for this record.</p>}</div>
    <details><summary>Stored JSON</summary><pre className="record-json">{detail.raw}</pre>
      {detail.rawTruncated && <p className="small muted">Heavy fields and long values are abbreviated.</p>}
    </details>
  </div>;
}
