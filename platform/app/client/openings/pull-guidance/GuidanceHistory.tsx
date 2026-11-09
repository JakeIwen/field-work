import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { GreenhouseGuidanceHistoryEntry } from "../../../shared/greenhouse-guidance";
import { api } from "../../workspace/api";
import { formatDate } from "../../ui/dates";
import { type Mutate } from "../../workspace/workspace-actions";
import { GuidancePopup } from "./GuidancePopup";

const historyPath = "/api/greenhouse/guidance/history";

export function GuidanceHistory({ mutate, onUse, onClose }: {
  mutate: Mutate; onUse: (instructions: string) => void; onClose: () => void;
}) {
  const [entries, setEntries] = useState<GreenhouseGuidanceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    api<GreenhouseGuidanceHistoryEntry[]>(historyPath).then(value => {
      if (live) setEntries(value);
    }).catch(cause => { if (live) setError(String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revision]);
  async function remove(id: string) {
    setDeleting(id); setError("");
    try {
      await mutate(`${historyPath}/${encodeURIComponent(id)}`, undefined, "DELETE");
      setEntries(current => current.filter(entry => entry.id !== id));
      setRevision(current => current + 1);
    } catch (cause) { setError(String(cause)); }
    finally { setDeleting(""); }
  }
  return <GuidancePopup title="Pull instruction history" onClose={onClose}>
    {loading && <p role="status">Loading history…</p>}
    {error && <div><p className="intake-error" role="alert">{error}</p><button type="button" className="button secondary" onClick={() => setRevision(current => current + 1)}>Refresh history</button></div>}
    {!loading && !error && !entries.length && <p>No saved instructions yet.</p>}
    <ul className="guidance-history-list">{entries.map(entry => <HistoryEntry key={entry.id} entry={entry} busy={Boolean(deleting) || loading} onUse={onUse} onDelete={() => void remove(entry.id)} />)}</ul>
  </GuidancePopup>;
}

function HistoryEntry({ entry, busy, onUse, onDelete }: {
  entry: GreenhouseGuidanceHistoryEntry; busy: boolean; onUse: (text: string) => void; onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <li className="guidance-history-entry">
    <p className="guidance-history-preview" data-expanded={expanded}>{entry.instructions}</p>
    <p className="small muted">First used {formatDate(entry.createdAt, true)} · Last used {formatDate(entry.lastUsedAt, true)}</p>
    <div className="guidance-history-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={() => onUse(entry.instructions)}>Use</button>
      <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show full text"}</button>
      <button type="button" className="icon-button" disabled={busy} aria-label="Delete saved instructions" title="Delete saved instructions" onClick={onDelete}><Trash2 size={16} aria-hidden="true" /></button>
    </div>
  </li>;
}
