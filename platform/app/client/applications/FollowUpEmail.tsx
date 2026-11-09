import { Check, Copy, LoaderCircle, Mail } from "lucide-react";
import { useState } from "react";
import AppLink from "../ui/AppLink";
import ErrorNotice from "../ui/ErrorNotice";
import { useTextCopy } from "../ui/useTextCopy";
import {
  followUpEligible,
  followUpLimits,
  type ApplicationFollowUpSummary,
} from "../../shared/follow-up-email";
import type { Application, TaskSummary } from "../../shared/types";
import { formatDate } from "../ui/dates";
import { type Go } from "../workspace/workspace-actions";
import { followUpDraftLabel } from "./follow-up-labels";
import { FollowUpRevise } from "./FollowUpRevise";
import { FollowUpSend, FollowUpSentList } from "./FollowUpSend";
import { useFollowUpEmail, type FollowUpEmailState } from "./useFollowUpEmail";
import "./follow-up.css";

function RecipientField({ f, locked }: { f: FollowUpEmailState; locked: boolean }) {
  const suggestions = [
    ...(f.followUp?.recipientCandidates ?? []).map((c) => ({
      email: c.email,
      note: `from ${c.source}${c.name ? ` (${c.name})` : ""}`,
      sourceUrl: undefined as string | undefined,
    })),
    ...(f.followUp?.suggestion
      ? [{ email: f.followUp.suggestion.email, note: f.followUp.suggestion.basis || "published by the employer", sourceUrl: f.followUp.suggestion.sourceUrl }]
      : []),
  ].filter((s, i, all) => s.email.toLowerCase() !== f.fields.to.trim().toLowerCase() && all.findIndex((x) => x.email === s.email) === i);
  return (
    <div className="follow-up-recipient">
      <label>
        To
        <input type="email" value={f.fields.to} readOnly={locked} maxLength={followUpLimits.to} placeholder="recruiter@company.com"
          autoComplete="off" onChange={(e) => f.setField("to", e.target.value)} />
      </label>
      {suggestions.map((s) => (
        <p key={s.email} className="small follow-up-suggestion">
          Suggested: <button type="button" className="text-button" disabled={locked} onClick={() => f.setField("to", s.email)}>{s.email}</button>
          {" "}<span className="muted">{s.note}</span>
          {s.sourceUrl && <> · <a href={s.sourceUrl} target="_blank" rel="noreferrer">source</a></>}
        </p>
      ))}
      {!f.fields.to && !suggestions.length && (
        <p className="small muted">No employer email is on file. Add the recruiter's or hiring manager's address when you have it.</p>
      )}
    </div>
  );
}

function Drafting({ f, go }: { f: FollowUpEmailState; go: Go }) {
  const generation = f.followUp?.generation;
  const taskId = generation?.taskId;
  const message = f.followUp?.draft
    ? "Revising the draft…"
    : "Drafting the follow-up email. This usually takes a minute or two.";
  return (
    <p className="follow-up-progress small" role="status">
      <LoaderCircle size={15} className="spin" aria-hidden="true" />
      {message}
      {taskId && <> <AppLink className="text-button" go={go} page="agents" id={taskId}>View progress</AppLink></>}
    </p>
  );
}

function DraftForm({ f, locked }: { f: FollowUpEmailState; locked: boolean }) {
  const [copyError, setCopyError] = useState("");
  const { copied, copy } = useTextCopy(setCopyError);
  const draft = f.followUp!.draft!;
  return (
    <form className="form-stack follow-up-form" onSubmit={(e) => { e.preventDefault(); void f.save(); }}>
      <RecipientField f={f} locked={locked} />
      <label>
        Subject
        <input value={f.fields.subject} readOnly={locked} maxLength={followUpLimits.subject} onChange={(e) => f.setField("subject", e.target.value)} />
      </label>
      <label>
        Email
        <textarea className="follow-up-body" rows={16} value={f.fields.body} readOnly={locked} maxLength={followUpLimits.body}
          spellCheck onChange={(e) => f.setField("body", e.target.value)} />
      </label>
      <div className="follow-up-actions">
        <button type="submit" className="button secondary" disabled={!f.dirty || locked}>{f.busy === "save" ? "Saving…" : "Save edits"}</button>
        {f.dirty && !locked && <button type="button" className="text-button" onClick={f.discard}>Discard changes</button>}
        <button type="button" className="text-button" onClick={() => void copy(`Subject: ${f.fields.subject}\n\n${f.fields.body}`, "follow-up")}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? "Copied" : "Copy text"}
        </button>
        <span className="small muted follow-up-saved">{f.dirty ? "Unsaved changes" : `${followUpDraftLabel(draft)} ${formatDate(draft.at, true)}`}</span>
      </div>
      {copyError && <ErrorNotice error={copyError} />}
    </form>
  );
}

/** The Application's main follow-up workflow: draft, edit, send, and revise. */
export function FollowUpEmail({
  application,
  followUp,
  tasks,
  go,
}: {
  application: Application;
  followUp?: ApplicationFollowUpSummary;
  tasks: TaskSummary[];
  go: Go;
}) {
  const f = useFollowUpEmail(application.id, followUp);
  const generation = f.followUp?.generation;
  const drafting = generation?.status === "drafting" || f.busy === "draft";
  const draft = f.followUp?.draft;
  const locked = drafting || !!f.followUp?.sending || !!f.busy;
  const headingId = `follow-up-heading-${application.id}`;
  return (
    <section className="follow-up" aria-labelledby={headingId}>
      <h3 id={headingId}><Mail size={16} aria-hidden="true" /> Follow-up email</h3>
      {!followUpEligible(application) ? (
        <p className="small muted">Follow-up emails are available once the application is recorded as sent.</p>
      ) : !draft ? (
        drafting ? <Drafting f={f} go={go} /> : (
          <div className="follow-up-start">
            {generation?.status === "failed" && <ErrorNotice error={generation.error || "Drafting failed."} />}
            <button type="button" className="button primary" disabled={!!f.busy} onClick={() => void f.draft()}>
              <Mail size={15} aria-hidden="true" /> {generation?.status === "failed" ? "Try drafting again" : "Draft follow-up email"}
            </button>
            {!!f.followUp?.sent.length && <FollowUpSentList sent={f.followUp.sent} />}
          </div>
        )
      ) : (
        <>
          <FollowUpSentList sent={f.followUp!.sent} />
          {drafting && <Drafting f={f} go={go} />}
          {generation?.status === "failed" && <ErrorNotice error={generation.error || "The revision failed."} />}
          <DraftForm f={f} locked={locked} />
          <FollowUpSend f={f} locked={locked} />
          {!!f.followUp!.sent.length && !locked && (
            <button type="button" className="text-button follow-up-another" onClick={() => void f.draft()}>
              <Mail size={14} aria-hidden="true" /> Draft another follow-up
            </button>
          )}
          <FollowUpRevise f={f} locked={locked} tasks={tasks} go={go} />
        </>
      )}
      {f.error && <ErrorNotice error={f.error} />}
    </section>
  );
}
