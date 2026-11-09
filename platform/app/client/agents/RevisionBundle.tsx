import InfoTooltip from "../ui/InfoTooltip";
import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ArrowDownToLine,
  ChevronRight,
  ExternalLink,
  FileText,
  ShieldCheck,
  X,
} from "lucide-react";
import { artifactGroups, artifactInfo } from "../../shared/bundle-files";
import type { AppState } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { stageLabel } from "../applications/stages";
import type { Go, Mutate } from "../workspace/workspace-actions";
import { PdfPreview } from "../ui/PdfPreview";
import { Badge } from "../ui/Badge";

type RevisionBundleProps = {
  bundle: any;
  task: any;
  state: AppState;
  go: Go;
  mutate: Mutate;
};

type SetValue<T> = Dispatch<SetStateAction<T>>;
type BundleValue = RevisionBundleProps["bundle"];
type TaskValue = RevisionBundleProps["task"];
type ArtifactValue = BundleValue["artifacts"][number];

function useDraftSources({
  path,
  task,
  setLoading,
  setPreviewError,
  setEditing,
  setOriginal,
  setText,
}: {
  path: string | undefined;
  task: TaskValue;
  setLoading: SetValue<boolean>;
  setPreviewError: SetValue<string>;
  setEditing: SetValue<boolean>;
  setOriginal: SetValue<string>;
  setText: SetValue<string>;
}) {
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setPreviewError("");
    setEditing(false);
    setOriginal("");
    const controller = new AbortController();
    if (/\.pdf$/i.test(path)) {
      setLoading(false);
      return;
    }
    api(
      `${entityUrl("/api/tasks", task.id)}/artifact?path=${encodeURIComponent(path)}`,
      undefined,
      undefined,
      { responseType: "response", signal: controller.signal },
    )
      .then((r) => {
        if (!r.ok) throw new Error("Draft artifact is unavailable");
        return r.text();
      })
      .then(setText)
      .catch((e) => {
        if (e.name !== "AbortError") setPreviewError(e.message);
      })
      .finally(() => setLoading(false));
    api(`/api/source?path=${encodeURIComponent(path)}`, undefined, undefined, {
      responseType: "response",
      signal: controller.signal,
    })
      .then((r) =>
        r.ok ? r.text() : "No original source exists at this path.",
      )
      .then(setOriginal)
      .catch(() => {});
    return () => controller.abort();
  }, [path, task.id, task.updatedAt]);
}

function BundleOverview({
  bundle,
  task,
}: Pick<RevisionBundleProps, "bundle" | "task">) {
  return (
    <>
      <div className="section-heading compact">
        <div className="heading-help">
          <h3>Revision bundle</h3>
          {!bundle.summary && <InfoTooltip label="About the revision bundle">These files are in this task’s isolated workspace, not the original repository. File labels show changes; validation results apply to the checked documents.</InfoTooltip>}
        </div>
        <Badge
          tone={
            bundle.status === "validated"
              ? "green"
              : /failed|conflict/.test(bundle.status)
                ? "amber"
                : "muted"
          }
        >
          {stageLabel(bundle.status || "Draft")}
        </Badge>
      </div>
      {task.fixture && (
        <div className="banner warning">
          Isolated verification fixture. This demonstrates the revision workflow
          and cannot become your current resume.
        </div>
      )}
      {bundle.summary && <p className="small">{bundle.summary}</p>}
    </>
  );
}

function ArtifactList({
  artifacts,
  bundle,
  setSelected,
}: {
  artifacts: BundleValue["artifacts"];
  bundle: BundleValue;
  setSelected: SetValue<ArtifactValue>;
}) {
  return Array.isArray(artifacts) ? (
    <>
      {artifactGroups.map((group) => {
        const files = artifacts.filter((item: any) =>
          artifactInfo(item, bundle.sourceHashes).group === group.id,
        );
        if (!files.length) return null;
        return (
          <details className="artifact-group" key={group.id} open={group.expanded}>
            <summary>{group.title} <span className="muted">({files.length})</span></summary>
            {files.map((item: any) => {
              const artifactPath = typeof item === "string" ? item : item.path;
              return (
                <button
                  className="linked-row artifact-path"
                  key={artifactPath}
                  onClick={() => setSelected(item)}
                >
                  <FileText size={14} />
                  <span>{artifactPath}</span>
                  <Badge tone="muted">{artifactInfo(item, bundle.sourceHashes).label}</Badge>
                  <ChevronRight size={14} />
                </button>
              );
            })}
          </details>
        );
      })}
    </>
  ) : null;
}

function BundleActions({
  task,
  mutate,
}: Pick<RevisionBundleProps, "task" | "mutate">) {
  return (
    <div className="row-wrap">
      <button
        className="button secondary small-button"
        onClick={() =>
          mutate(`${entityUrl("/api/tasks", task.id)}/validate`, {}).catch(
            () => {},
          )
        }
      >
        <ShieldCheck size={14} /> Run bundle validation
      </button>
      <a
        className="text-button"
        href={`${entityUrl("/api/tasks", task.id)}/bundle`}
        download
      >
        <ArrowDownToLine size={14} /> Export draft bundle
      </a>
    </div>
  );
}

function ValidationResults({
  bundle,
  checks,
}: {
  bundle: BundleValue;
  checks: BundleValue["validation"]["checks"];
}) {
  return (
    <>
      {checks.length > 0 && (
        <div className="validation-checks">
          <h3>Actual validation results</h3>
          {checks.map((check: any, i: number) => (
            <details key={i}>
              <summary>
                <Badge
                  tone={
                    check.status === "passed"
                      ? "green"
                      : check.status === "failed"
                        ? "red"
                        : "muted"
                  }
                >
                  {check.status}
                </Badge>{" "}
                {check.name}
              </summary>
              <pre>{check.output || "No output returned."}</pre>
            </details>
          ))}
          <span className="tiny muted">
            Validated{" "}
            {formatDate(bundle.validation.at, true)}
          </span>
        </div>
      )}
      {bundle.validation && !checks.length && (
        <pre className="validation-result">
          {JSON.stringify(bundle.validation, null, 2)}
        </pre>
      )}
    </>
  );
}

function ConflictWarning({ bundle }: { bundle: BundleValue }) {
  return bundle.validation?.conflicts?.length > 0 ||
    bundle.conflicts?.length > 0 ? (
    <div className="banner danger">
      External changes conflict with this draft. Preserve it and resolve the
      changed source before promotion.
    </div>
  ) : null;
}

function PdfDraft({ path, task }: { path: string; task: TaskValue }) {
  return (
    <>
      <PdfPreview
        title="Isolated draft PDF"
        src={`${entityUrl("/api/tasks", task.id)}/artifact?path=${encodeURIComponent(path)}`}
      />
      <a
        className="text-button"
        href={`${entityUrl("/api/tasks", task.id)}/artifact?path=${encodeURIComponent(path)}`}
        target="_blank"
        rel="noreferrer"
      >
        Open draft PDF <ExternalLink size={12} />
      </a>
    </>
  );
}

function EditDraftForm({
  path,
  artifacts,
  selected,
  text,
  setText,
  setEditing,
  task,
  mutate,
}: {
  path: string;
  artifacts: BundleValue["artifacts"];
  selected: ArtifactValue;
  text: string;
  setText: SetValue<string>;
  setEditing: SetValue<boolean>;
  task: TaskValue;
  mutate: Mutate;
}) {
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutate(
          `${entityUrl("/api/tasks", task.id)}/artifact`,
          {
            path,
            expectedHash:
              artifacts.find((item: any) => item.path === path)?.hash ||
              selected.hash,
            content: text,
          },
          "PUT",
        )
          .then(() => setEditing(false))
          .catch(() => {});
      }}
    >
      <textarea
        aria-label="Edit isolated artifact"
        rows={15}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="button secondary small-button">
        Save draft with hash check
      </button>
    </form>
  );
}

function DraftComparison({
  original,
  text,
}: {
  original: string;
  text: string;
}) {
  return (
    <div className="draft-source-comparison">
      <details>
        <summary>Original repository source</summary>
        <pre>{original || "Loading original…"}</pre>
      </details>
      <details open>
        <summary>Proposed draft source</summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

function SourceDraft({
  path,
  artifacts,
  selected,
  text,
  original,
  previewError,
  editing,
  setText,
  setEditing,
  task,
  mutate,
}: {
  path: string;
  artifacts: BundleValue["artifacts"];
  selected: ArtifactValue;
  text: string;
  original: string;
  previewError: string;
  editing: boolean;
  setText: SetValue<string>;
  setEditing: SetValue<boolean>;
  task: TaskValue;
  mutate: Mutate;
}) {
  return (
    <>
      {previewError && <div className="banner danger">{previewError}</div>}
      <div className="row-wrap">
        <button className="text-button" onClick={() => setEditing(!editing)}>
          {editing ? "Cancel editing" : "Edit isolated draft"}
        </button>
        <a
          className="text-button"
          href={`${entityUrl("/api/tasks", task.id)}/artifact?path=${encodeURIComponent(path)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open draft source
        </a>
      </div>
      {editing ? (
        <EditDraftForm
          path={path}
          artifacts={artifacts}
          selected={selected}
          text={text}
          setText={setText}
          setEditing={setEditing}
          task={task}
          mutate={mutate}
        />
      ) : (
        <DraftComparison original={original} text={text} />
      )}
    </>
  );
}

function DraftPreview({
  path,
  artifacts,
  selected,
  setSelected,
  text,
  setText,
  original,
  previewError,
  editing,
  setEditing,
  loading,
  task,
  mutate,
}: {
  path: string;
  artifacts: BundleValue["artifacts"];
  selected: ArtifactValue;
  setSelected: SetValue<ArtifactValue>;
  text: string;
  setText: SetValue<string>;
  original: string;
  previewError: string;
  editing: boolean;
  setEditing: SetValue<boolean>;
  loading: boolean;
  task: TaskValue;
  mutate: Mutate;
}) {
  return (
    <div className="draft-preview">
      <div className="section-heading compact">
        <h3>Task file</h3>
        <button
          className="icon-button"
          aria-label="Close task file"
          title="Close task file"
          onClick={() => setSelected(null)}
        >
          <X size={15} />
        </button>
      </div>
      <p className="tiny muted">{path}</p>
      {/\.pdf$/i.test(path) ? (
        <PdfDraft path={path} task={task} />
      ) : loading ? (
        <p>Loading draft source…</p>
      ) : (
        <SourceDraft
          path={path}
          artifacts={artifacts}
          selected={selected}
          text={text}
          original={original}
          previewError={previewError}
          editing={editing}
          setText={setText}
          setEditing={setEditing}
          task={task}
          mutate={mutate}
        />
      )}
    </div>
  );
}

function PromotionAction({
  bundle,
  task,
  mutate,
}: Pick<RevisionBundleProps, "bundle" | "task" | "mutate">) {
  return !task.fixture &&
    task.preset === "resume-revision" &&
    bundle.scope !== "tailored" &&
    /^source_master_template\/v\d+(?:_[a-z]+)?$/.test(bundle.versionDir || "") &&
    bundle.status === "validated" ? (
    <div className="promotion-action">
      <button
        className="button primary small-button"
        title="Make this validated general revision current; source hashes are rechecked and concurrent external edits block promotion."
        onClick={() =>
          mutate(`${entityUrl("/api/tasks", task.id)}/promote`, {
            expectedSourceHashes: bundle.sourceHashes,
          }).catch(() => {})
        }
      >
        Make current general version
      </button>
    </div>
  ) : null;
}

export default function RevisionBundle({
  bundle,
  task,
  state,
  go,
  mutate,
}: RevisionBundleProps) {
  const artifacts = bundle.artifacts || [];
  const [selected, setSelected] = useState<any>(null),
    [text, setText] = useState(""),
    [original, setOriginal] = useState(""),
    [previewError, setPreviewError] = useState(""),
    [editing, setEditing] = useState(false),
    [loading, setLoading] = useState(false);
  const path = typeof selected === "string" ? selected : selected?.path;
  const checks = bundle.validation?.checks || [];
  useDraftSources({
    path,
    task,
    setLoading,
    setPreviewError,
    setEditing,
    setOriginal,
    setText,
  });
  return (
    <section className="revision-bundle">
      <BundleOverview bundle={bundle} task={task} />
      <ArtifactList
        artifacts={artifacts}
        bundle={bundle}
        setSelected={setSelected}
      />
      <BundleActions task={task} mutate={mutate} />
      <ValidationResults
        bundle={bundle}
        checks={checks}
      />
      <ConflictWarning bundle={bundle} />
      {path && (
        <DraftPreview
          path={path}
          artifacts={artifacts}
          selected={selected}
          setSelected={setSelected}
          text={text}
          setText={setText}
          original={original}
          previewError={previewError}
          editing={editing}
          setEditing={setEditing}
          loading={loading}
          task={task}
          mutate={mutate}
        />
      )}
      <PromotionAction bundle={bundle} task={task} mutate={mutate} />
    </section>
  );
}
