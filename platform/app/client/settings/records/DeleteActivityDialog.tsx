import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JournalDeletionRequest, JournalDeletionResult } from "../../../shared/activity";
import { api } from "../../workspace/api";

export function DeleteActivityDialog({ ids, onClose, onDeleted }: {
  ids: string[]; onClose: () => void; onDeleted: (result: JournalDeletionResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function remove() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      const body: JournalDeletionRequest = { ids };
      const result = await api<JournalDeletionResult>("/api/journal", body, "DELETE");
      onDeleted(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { sending.current = false; setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="delete-record-dialog" aria-label="Delete selected activity"
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClose={() => { if (!busy) onClose(); }}>
    <h2>Delete {ids.length} activity {ids.length === 1 ? "entry" : "entries"}?</h2>
    <p>This permanently removes the selected journal entries only. Applications, documents and other records they mention are kept. This cannot be undone in Fieldwork.</p>
    {error && <p role="alert" className="error-text">{error}</p>}
    <div className="row-wrap">
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? "Deleting…" : "Permanently delete activity"}</button>
    </div>
  </dialog>, document.body);
}
