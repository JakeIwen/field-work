import { useState } from "react";
import AppLink from "../ui/AppLink";
import { tunableValue } from "../../shared/tunables";
import { PreparationStatusLine } from "../preparation/ApplicationPreparation";
import { ApplicationStageForm, type ApplicationStageFields } from "./ApplicationStageForm";
import { FollowUpEmail } from "./FollowUpEmail";
import { suggestedAction } from "./suggested-action";
import { ArrowDownToLine, ArrowRight, Copy, FileText, X } from "lucide-react";
import type { AppState, Application, Document } from "../../shared/types";
import type { ApplicationPackage } from "../../shared/task-records";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { stageLabel } from "./stages";
import type { Go, Mutate } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import { Badge } from "../ui/Badge";
import { Field } from "../ui/Field";
import { ActivityHistory } from "../settings/records/ActivityHistory";
import { useTextCopy } from "../ui/useTextCopy";
import "./follow-up.css";

function ApplicationTracking({ application: a, mutate }: { application: Application; mutate: Mutate }) {
  const [form, setForm] = useState<ApplicationStageFields>({
    status: a.status,
    nextAction: a.nextAction,
    followUp: a.followUp,
    contacts: a.contacts,
    notes: a.notes,
  });
  return (
    <ApplicationStageForm
      form={form}
      submitted={!!a.submittedAt}
      suggestedActionText={suggestedAction(a) || undefined}
      onChange={(key, value) => setForm((f) => ({ ...f, [key]: value }))}
      onSubmit={(e) => {
        e.preventDefault();
        mutate(entityUrl("/api/applications", a.id), { expectedVersion: a.version, ...form }, "PATCH").catch(() => {});
      }}
    />
  );
}

type PackageDocument = ApplicationPackage["documents"][number];

function DocumentRow({ name, privacy, detail }: { name: string; privacy?: string; detail?: string }) {
  return (
    <li className="sent-file">
      <FileText size={15} aria-hidden="true" />
      <span>
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <Badge tone={privacy === "private" ? "amber" : "muted"}>{privacy || "unknown"}</Badge>
    </li>
  );
}

function SubmittedAutofillCopy({ openingId, scriptId }: { openingId: string; scriptId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [script, setScript] = useState("");
  const { copied, copy } = useTextCopy(setError);
  async function recopy() {
    if (loading) return;
    setLoading(true); setError(""); setScript("");
    try {
      const response = await api(`${entityUrl("/api/openings", openingId)}/autofill/${encodeURIComponent(scriptId)}`, undefined, undefined, { responseType: "response" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not load the saved autofill script. Try again.");
      }
      const text = await response.text();
      setScript(text);
      await copy(text, scriptId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  return <div>
    <button type="button" className="button secondary" disabled={loading} onClick={recopy}
      title="Copy the original script saved with this submission; the recorded submission date and documents stay unchanged. Running it sends included answers and files to the employer before final Submit.">
      <Copy size={15} aria-hidden="true" /> {loading ? "Copying…" : copied === scriptId && !error ? "Copied" : "Copy autofill script"}
    </button>
    {error && <p role="alert" className="small error-text">{error}</p>}
    {error && script && <textarea aria-label="Autofill script to copy" readOnly rows={8} value={script} onFocus={e => e.currentTarget.select()} />}
  </div>;
}

function SubmittedDocuments({ application: a }: { application: Application }) {
  const packages = (a.packages ?? []).filter((p) => p.documents?.length || p.scriptId);
  return (
    <>
      {a.submissionSource === "autofill-copy" && (
        <p className="small muted">Recorded when you copied the autofill script. This does not confirm employer receipt.</p>
      )}
      {!packages.some(p => p.documents?.length) && <p className="small muted">No documents were saved with this submission record.</p>}
      {!packages.some(p => p.scriptId) && <p className="small muted">No autofill script was saved with this submission.</p>}
      {packages.map((p, i) => (
        <div key={p.id || i} className="sent-package-files">
          {packages.length > 1 && <span className="field-label">Package {i + 1}</span>}
          <ul className="package-files">
            {p.documents.map((d: PackageDocument) => (
              <DocumentRow key={d.id} name={d.name || d.id} privacy={d.privacy}
                detail={`${d.version ?? ""} · ${d.format?.toUpperCase() ?? ""} · ${stageLabel(d.kind || "Document")}`} />
            ))}
          </ul>
          {p.scriptId && <SubmittedAutofillCopy key={p.scriptId} openingId={a.openingId} scriptId={p.scriptId} />}
        </div>
      ))}
      {!!a.packages?.at(-1)?.documents?.length && (
        <a className="button secondary" href={`${entityUrl("/api/applications", a.id)}/export`} download>
          <ArrowDownToLine size={15} /> Download saved documents (ZIP)
        </a>
      )}
    </>
  );
}

function DraftPackage({ application: a, documents, mutate }: { application: Application; documents: Document[]; mutate: Mutate }) {
  const [record, setRecord] = useState(false);
  const files = (a.documentIds ?? []).map((id) => documents.find((d) => d.id === id) ?? { id, name: id, privacy: "unknown" });
  return (
    <>
      {files.length ? (
        <ul className="package-files">
          {files.map((d) => <DocumentRow key={d.id} name={d.name} privacy={d.privacy} />)}
        </ul>
      ) : (
        <p className="small muted">No package yet. Generate Docs on the Opening creates the resume and cover letter and attaches them here.</p>
      )}
      {files.length > 0 && (
        <a className="text-button draft-export" href={`${entityUrl("/api/applications", a.id)}/export`} download>
          <ArrowDownToLine size={14} /> Export saved draft package
        </a>
      )}
      <button className="button secondary full-width" disabled={!files.length} onClick={() => setRecord(!record)}>
        Record application sent
      </button>
      {record && (
        <div className="submission-confirm">
          <p className="small">This records that you already sent these documents. It does not contact the employer. The server saves immutable copies and a UTC timestamp.</p>
          <button
            className="button primary"
            onClick={() =>
              mutate(`${entityUrl("/api/applications", a.id)}/submit`, { expectedVersion: a.version, documentIds: a.documentIds || [] })
                .then(() => setRecord(false))
                .catch(() => {})
            }
          >
            I sent these documents · Record it
          </button>
        </div>
      )}
    </>
  );
}

function ApplicationHistory({ application: a, go, pageSize }: { application: Application; go: Go; pageSize: number }) {
  const [opened, setOpened] = useState(false);
  return <details className="application-section" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>History</summary>
    {a.applicationDate && <Field label="Application started">{a.applicationDate}</Field>}
    {a.submittedAt && <Field label="Submission recorded">{formatDate(a.submittedAt, true)}</Field>}
    {opened && <ActivityHistory key={`${a.updatedAt}:${a.version}`} entityId={a.id} go={go} pageSize={pageSize} />}
    <p className="tiny muted">Draft created {formatDate(a.createdAt, true)}.</p>
  </details>;
}

export function ApplicationDetail({
  application: a,
  state,
  mutate,
  go,
}: {
  application: Application;
  state: AppState;
  mutate: Mutate;
  go: Go;
  agent?: (c: Partial<Context>, p?: string) => void;
}) {
  const o = state.openings.find((o) => o.id === a.openingId);
  const preparation = state.preparations?.find((r) => r.openingId === a.openingId);
  const submitted = !!a.submittedAt || !!a.packages?.length;
  return (
    <aside className="panel detail-panel application-detail">
      <div className="detail-top">
        <Badge tone="blue">{stageLabel(a.status)}</Badge>
        <AppLink className="icon-button" aria-label="Close application detail" title="Close application detail" go={go} page={"applications"}>
          <X size={18} />
        </AppLink>
      </div>
      <div className="detail-heading">
        <span className="eyebrow">{o?.company}</span>
        <h2>{o?.title || "Application"}</h2>
        <AppLink className="text-button" go={go} page={"openings"} id={a.openingId}>
          Role research <ArrowRight size={14} />
        </AppLink>
      </div>
      <div className="detail-content">
        {o && !a.submittedAt && <PreparationStatusLine run={preparation} go={go} openingId={o.id} tasks={state.tasks} runs={state.preparations} />}
        <FollowUpEmail application={a} followUp={state.followUps?.find((f) => f.applicationId === a.id)} tasks={state.tasks} go={go} />
        <details className="application-section">
          <summary>Stage, follow-up date and notes</summary>
          <ApplicationTracking key={a.version} application={a} mutate={mutate} />
        </details>
        <details className="application-section">
          <summary>{submitted ? "Submitted documents" : "Application package"}</summary>
          {submitted ? <SubmittedDocuments application={a} /> : <DraftPackage application={a} documents={state.documents} mutate={mutate} />}
        </details>
        <ApplicationHistory key={a.id} application={a} go={go} pageSize={tunableValue(state.settings, "records.activityPageSize")} />
      </div>
    </aside>
  );
}
