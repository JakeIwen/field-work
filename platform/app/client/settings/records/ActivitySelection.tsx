import { useRef, useState } from "react";
import { journalDeletionMaxIds, type ActivityPage, type JournalArchiveRequest, type JournalArchiveResult } from "../../../shared/activity";
import { api } from "../../workspace/api";
import type { Go } from "../../workspace/workspace-actions";
import { ActivityEntries } from "./ActivityEntries";
import { DeleteActivityDialog } from "./DeleteActivityDialog";
type Props = { page: ActivityPage; go: Go; onChanged: () => void };
type Result = { text: string; undo?: { ids: string[]; archived: boolean } };

const entries = (count: number) => `${count} activity ${count === 1 ? "entry" : "entries"}`;

export function ActivitySelection({ page, go, onChanged }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmIds, setConfirmIds] = useState<string[]>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const sending = useRef(false);
  const atLimit = selected.size >= journalDeletionMaxIds;
  const chosen = page.entries.filter(entry => selected.has(entry.id));
  const toArchive = chosen.filter(entry => !entry.archivedAt).map(entry => entry.id);
  const toRestore = chosen.filter(entry => entry.archivedAt).map(entry => entry.id);
  function toggle(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < journalDeletionMaxIds) next.add(id);
      return next;
    });
  }
  async function setArchived(ids: string[], archived: boolean, undoable = true) {
    if (sending.current || !ids.length) return;
    sending.current = true; setArchiving(true); setError("");
    try {
      const body: JournalArchiveRequest = { ids, archived };
      const outcome = await api<JournalArchiveResult>("/api/journal/archive", body, "POST");
      onChanged();
      setSelected(current => new Set([...current].filter(id => !ids.includes(id))));
      setResult({ text: `${archived ? "Archived" : "Restored"} ${entries(outcome.updated)}.${outcome.missing ? ` ${outcome.missing} no longer exist.` : ""}`,
        undo: undoable && outcome.updated ? { ids, archived: !archived } : undefined });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { sending.current = false; setArchiving(false); }
  }
  return <>
    <div className="row-wrap activity-selection" role="group" aria-label="Activity cleanup">
      <button type="button" className="button secondary" disabled={!page.entries.length}
        onClick={() => setSelected(new Set(page.entries.slice(0, journalDeletionMaxIds).map(entry => entry.id)))}>Select shown</button>
      <button type="button" className="text-button" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
      <button type="button" className="button secondary" disabled={!toArchive.length || archiving}
        onClick={() => void setArchived(toArchive, true)}>Archive selected ({toArchive.length})</button>
      {page.entries.some(entry => entry.archivedAt) && <button type="button" className="button secondary" disabled={!toRestore.length || archiving}
        onClick={() => void setArchived(toRestore, false)}>Restore selected ({toRestore.length})</button>}
      <button type="button" className="button danger" disabled={!selected.size}
        onClick={() => setConfirmIds([...selected])}>Delete selected ({selected.size})</button>
    </div>
    {atLimit && <p role="status" className="small">Up to {journalDeletionMaxIds} entries can be archived or deleted at once.</p>}
    {result && <p role="status" className="small">{result.text}{result.undo && <> <button type="button" className="text-button" disabled={archiving}
      onClick={() => void setArchived(result.undo!.ids, result.undo!.archived, false)}>Undo</button></>}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <ActivityEntries entries={page.entries} go={go} selection={{ ids: selected, toggle }} archiving={{ setArchived: (ids, archived) => void setArchived(ids, archived), disabled: archiving }} />
    {confirmIds && <DeleteActivityDialog ids={confirmIds} onClose={() => setConfirmIds(undefined)} onDeleted={outcome => {
      onChanged();
      setSelected(new Set()); setConfirmIds(undefined);
      setResult({ text: `Deleted ${entries(outcome.deleted)}.${outcome.missing ? ` ${outcome.missing} already removed.` : ""}` });
    }} />}
  </>;
}
