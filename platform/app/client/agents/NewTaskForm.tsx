import InfoTooltip from "../ui/InfoTooltip";
import {
  BriefcaseBusiness,
  Building2,
  FileText,
  FolderOpen,
  LoaderCircle,
  Send,
  Sparkles,
} from "lucide-react";
import type { AppState } from "../../shared/types";
import { presets } from "./task-presets";
import { textMatch } from "../ui/text-match";
import type { Context } from "./task-context";
import { Badge } from "../ui/Badge";
import { SearchBox } from "../ui/SearchBox";
import { Select } from "../ui/Select";

type Opening = AppState["openings"][number];
type Company = AppState["companies"][number];
type Document = AppState["documents"][number];
type SetContext = (value: Context | ((current: Context) => Context)) => void;

type NewTaskFormProps = {
  preset: string;
  setPreset: (value: string) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  ctx: Context;
  setCtx: SetContext;
  docQuery: string;
  setDocQuery: (value: string) => void;
  openings: Opening[];
  companies: Company[];
  documents: Document[];
  opening?: Opening;
  company?: Company;
  mode: string;
  setMode: (value: string) => void;
  liveAvailable: boolean;
  sending: boolean;
  start: () => Promise<void>;
};

type ContextPickerProps = Pick<
  NewTaskFormProps,
  | "ctx"
  | "setCtx"
  | "docQuery"
  | "setDocQuery"
  | "openings"
  | "companies"
  | "documents"
  | "opening"
  | "company"
>;

function PresetIcon({ id }: { id: string }) {
  return id === "resume-revision" ? (
    <FileText size={18} />
  ) : id === "company-research" ? (
    <Building2 size={18} />
  ) : id === "cover-letter" ? (
    <FolderOpen size={18} />
  ) : (
    <BriefcaseBusiness size={18} />
  );
}

function PresetGrid({
  preset,
  setPreset,
  setPrompt,
}: Pick<NewTaskFormProps, "preset" | "setPreset" | "setPrompt">) {
  return (
    <div className="preset-grid">
      {Object.entries(presets).map(([id, p]) => (
        <button
          key={id}
          className={`preset ${preset === id ? "selected" : ""}`}
          onClick={() => {
            setPreset(id);
            setPrompt(p.prompt);
          }}
        >
          <PresetIcon id={id} />
          <span>{p.title}</span>
        </button>
      ))}
    </div>
  );
}

function OpeningPicker({
  ctx,
  setCtx,
  openings,
}: Pick<NewTaskFormProps, "ctx" | "setCtx" | "openings">) {
  return (
    <label>
      Opening
      <select
        value={ctx.openingId || ""}
        onChange={(e) => {
          const o = openings.find((o) => o.id === e.target.value);
          setCtx((c) => ({
            ...c,
            openingId: e.target.value || undefined,
            companyId: o?.company_id || c.companyId,
          }));
        }}
      >
        <option value="">No specific opening</option>
        {openings.map((o) => (
          <option key={o.id} value={o.id}>
            {o.company} · {o.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompanyPicker({
  ctx,
  setCtx,
  companies,
}: Pick<NewTaskFormProps, "ctx" | "setCtx" | "companies">) {
  return (
    <label>
      Company
      <select
        value={ctx.companyId || ""}
        onChange={(e) =>
          setCtx((c) => ({
            ...c,
            companyId: e.target.value || undefined,
          }))
        }
      >
        <option value="">No specific company</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DocumentChoices({
  ctx,
  setCtx,
  docQuery,
  documents,
}: Pick<NewTaskFormProps, "ctx" | "setCtx" | "docQuery" | "documents">) {
  return (
    <div className="document-picker context-docs">
      {documents
        .filter(
          (d) =>
            (docQuery
              ? textMatch(docQuery, d.path, d.company, d.version, d.kind)
              : d.status === "current") &&
            ["md", "html", "pdf"].includes(d.format),
        )
        .slice(0, 40)
        .map((d) => (
          <label key={d.id} className="document-choice">
            <input
              type="checkbox"
              checked={ctx.documentIds.includes(d.id)}
              onChange={(e) =>
                setCtx((c) => ({
                  ...c,
                  documentIds: e.target.checked
                    ? [...c.documentIds, d.id]
                    : c.documentIds.filter((id) => id !== d.id),
                }))
              }
            />
            <span>
              <strong>
                {d.company || "General"} · {d.version} ·{" "}
                {d.format}
              </strong>
              <small>
                {d.privacy} · {d.path}
              </small>
            </span>
          </label>
        ))}
    </div>
  );
}

function ContextManifest({
  ctx,
  documents,
  opening,
  company,
}: Pick<NewTaskFormProps, "ctx" | "documents" | "opening" | "company">) {
  return (
    <div className="context-manifest">
      <span className="field-label">
        Included repository instructions & evidence
      </span>
      <code>AGENTS.md</code>
      <code>source_data/README.md</code>
      <code>source_data/github_evidence_dossier.md</code>
      <code>
        source_data/resume.md
      </code>
      {opening && (
        <code>
          {opening.sourcePath} · {opening.company} /{" "}
          {opening.job_id}
        </code>
      )}
      {company && (
        <code>
          {company.sourcePath} · {company.name}
        </code>
      )}
      {ctx.documentIds.map((id) => (
        <code key={id}>{documents.find((d) => d.id === id)?.path || id}</code>
      ))}
    </div>
  );
}

function ContextPicker(props: ContextPickerProps) {
  return (
    <div className="context-picker">
      <div className="section-heading compact">
        <div className="heading-help">
          <h3>Context to supply</h3>
          <InfoTooltip label="About supplied context">Large evidence archives, signed offer documents and historical ATS identities are not included by default.</InfoTooltip>
        </div>
        <Badge tone="muted">Editable & explicit</Badge>
      </div>
      <OpeningPicker
        ctx={props.ctx}
        setCtx={props.setCtx}
        openings={props.openings}
      />
      <CompanyPicker
        ctx={props.ctx}
        setCtx={props.setCtx}
        companies={props.companies}
      />
      <label>Selected document versions</label>
      <SearchBox
        value={props.docQuery}
        onChange={props.setDocQuery}
        placeholder="Find context documents…"
      />
      <DocumentChoices
        ctx={props.ctx}
        setCtx={props.setCtx}
        docQuery={props.docQuery}
        documents={props.documents}
      />
      <ContextManifest
        ctx={props.ctx}
        documents={props.documents}
        opening={props.opening}
        company={props.company}
      />
    </div>
  );
}

function LaunchControls({
  mode,
  liveAvailable,
  sending,
  prompt,
  start,
}: Pick<
  NewTaskFormProps,
  "mode" | "liveAvailable" | "sending" | "prompt" | "start"
>) {
  return (
    <div className="row-wrap">
      <button
        className="button primary"
        title={mode === "handoff" ? "Export and continue in your installed Codex environment." : undefined}
        disabled={sending || !prompt.trim() || (mode === "live" && !liveAvailable)}
        onClick={start}
      >
        {sending ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Send size={15} />
        )}{" "}
        {mode === "live" ? "Start agent task" : "Save handoff task"}
      </button>
    </div>
  );
}

function TaskFields(props: NewTaskFormProps) {
  return (
    <div className="form-stack">
      <label>
        Task prompt
        <textarea
          className="task-prompt"
          rows={8}
          value={props.prompt}
          onChange={(e) => props.setPrompt(e.target.value)}
        />
      </label>
      <ContextPicker
        ctx={props.ctx}
        setCtx={props.setCtx}
        docQuery={props.docQuery}
        setDocQuery={props.setDocQuery}
        openings={props.openings}
        companies={props.companies}
        documents={props.documents}
        opening={props.opening}
        company={props.company}
      />
      <Select
        label="Execution"
        value={props.mode}
        onChange={props.setMode}
        options={
          props.liveAvailable
            ? [
                ["live", "Live agent conversation"],
                ["handoff", "Save editable handoff prompt"],
              ]
            : [["handoff", "Save editable handoff prompt"]]
        }
        help={<InfoTooltip label="About task execution">Live tasks show approval requests here. Handoffs save a prompt and context to export; no agent runs until you launch it.</InfoTooltip>}
      />
      <LaunchControls
        mode={props.mode}
        liveAvailable={props.liveAvailable}
        sending={props.sending}
        prompt={props.prompt}
        start={props.start}
      />
    </div>
  );
}

export default function NewTaskForm(props: NewTaskFormProps) {
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Start a focused task</h2>
        </div>
        <Sparkles size={20} />
      </div>
      <div className="agent-compose">
        <PresetGrid
          preset={props.preset}
          setPreset={props.setPreset}
          setPrompt={props.setPrompt}
        />
        <TaskFields {...props} />
      </div>
    </>
  );
}
