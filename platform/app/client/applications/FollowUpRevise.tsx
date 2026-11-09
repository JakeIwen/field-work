import { useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import AppLink from "../ui/AppLink";
import {
  followUpLimits,
  type FollowUpDraft,
} from "../../shared/follow-up-email";
import type { TaskSummary } from "../../shared/types";
import { formatDate } from "../ui/dates";
import { type Go } from "../workspace/workspace-actions";
import { followUpDraftLabel } from "./follow-up-labels";
import type { FollowUpEmailState } from "./useFollowUpEmail";

/** The model's short note about a revision, from the turn that saved it. */
function assistantNote(tasks: TaskSummary[], draft: FollowUpDraft) {
  if (!draft.taskId || !draft.turnId) return "";
  const task = tasks.find((t) => t.id === draft.taskId);
  return (
    task?.messages
      .filter((m) => m.role === "assistant" && m.turnId === draft.turnId)
      .map((m) => m.text.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function RevisionLog({ f, tasks }: { f: FollowUpEmailState; tasks: TaskSummary[] }) {
  const revisions = [f.followUp?.draft, ...f.history]
    .filter((d): d is FollowUpDraft => !!d && d.source === "revised" && !!d.instruction)
    .reverse();
  const pending = f.followUp?.generation;
  if (!revisions.length && !(pending?.kind === "revise" && pending.instruction)) return null;
  return (
    <ol className="follow-up-log">
      {revisions.map((draft) => {
        const note = assistantNote(tasks, draft);
        return (
          <li key={draft.id}>
            <p className="small"><strong>You:</strong> {draft.instruction}</p>
            {note && <p className="small muted">{note}</p>}
          </li>
        );
      })}
      {pending?.kind === "revise" && pending.instruction && (
        <li>
          <p className="small"><strong>You:</strong> {pending.instruction}</p>
          {pending.status === "drafting" && <p className="small muted" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Revising…</p>}
        </li>
      )}
    </ol>
  );
}

function EarlierDrafts({ f, locked }: { f: FollowUpEmailState; locked: boolean }) {
  if (!f.history.length) return null;
  return (
    <details className="follow-up-history">
      <summary className="small">Earlier drafts ({f.history.length})</summary>
      <ol>
        {f.history.map((draft) => (
          <li key={draft.id}>
            <div className="follow-up-history-head small">
              <span>{followUpDraftLabel(draft)} · {formatDate(draft.at, true)}</span>
              <button type="button" className="text-button" disabled={locked} onClick={() => void f.restore(draft.id)}>Restore</button>
            </div>
            <details>
              <summary className="small">{draft.subject || "No subject"}</summary>
              <pre className="follow-up-sent-body">{draft.body}</pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Default-collapsed: ask the drafting model for changes, restore earlier versions, or start over. */
export function FollowUpRevise({ f, locked, tasks, go }: { f: FollowUpEmailState; locked: boolean; tasks: TaskSummary[]; go: Go }) {
  const [instruction, setInstruction] = useState("");
  const taskId = f.followUp?.draftTaskId;
  return (
    <details className="follow-up-revise">
      <summary>Revise with AI</summary>
      <div className="follow-up-revise-body">
        <RevisionLog f={f} tasks={tasks} />
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            const request = instruction.trim();
            if (!request) return;
            void f.revise(request)?.then((result) => { if (result) setInstruction(""); });
          }}
        >
          <label>
            What should change?
            <textarea rows={3} value={instruction} maxLength={followUpLimits.instruction} disabled={locked}
              placeholder="For example: shorter, and lead with the data-pipeline work instead of the API migration"
              onChange={(e) => setInstruction(e.target.value)} />
          </label>
          <div className="follow-up-actions">
            <button type="submit" className="button secondary" disabled={locked || !instruction.trim()}>
              <Sparkles size={14} aria-hidden="true" /> {f.busy === "revise" ? "Sending…" : "Revise draft"}
            </button>
          </div>
          {f.dirty && <p className="small muted">Your unsaved edits are saved and included.</p>}
        </form>
        <EarlierDrafts f={f} locked={locked} />
        <div className="follow-up-actions">
          <button type="button" className="text-button" disabled={locked || f.dirty} title={f.dirty ? "Save or discard your edits first" : undefined}
            onClick={() => void f.draft()}>Start over with a new draft</button>
          {taskId && <AppLink className="text-button" go={go} page="agents" id={taskId}>Open the drafting conversation</AppLink>}
        </div>
      </div>
    </details>
  );
}
