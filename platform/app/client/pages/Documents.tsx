import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import React, { useEffect, useState } from "react";
import { ArrowDownToLine, ChevronRight, FileText, GitCompareArrows, Sparkles } from "lucide-react";
import type { AppState } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { textMatch } from "../ui/text-match";
import { stageLabel } from "../applications/stages";
import type { Go, Mutate } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import { PdfPreview } from "../ui/PdfPreview";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Source } from "../ui/Source";
import { SearchBox } from "../ui/SearchBox";
import { Select } from "../ui/Select";

const documentKindLabel = (kind: string) =>
  kind === "cover-letter" ? "Cover letter" : stageLabel(kind);

export function Documents({
  state,
  selected,
  go,
  mutate,
  agent,
}: {
  state: AppState;
  selected: string;
  go: Go;
  mutate: Mutate;
  agent: (c: Partial<Context>, p?: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [scope, setScope] = useState(""),
    [kind, setKind] = useState(""),
    [privacy, setPrivacy] = useState(""),
    [tab, setTab] = useState("preview"),
    [compareId, setCompareId] = useState(""),
    [comparison, setComparison] = useState<any>(null),
    [compareError, setCompareError] = useState("");
  const list = state.documents
    .filter(
      (d) =>
        textMatch(query, d.name, d.path, d.company, d.version) &&
        (!scope || d.scope === scope) &&
        (!kind || d.kind === kind) &&
        (!privacy || d.privacy === privacy),
    )
    .sort(
      (a, b) =>
        Number(b.status === "current") - Number(a.status === "current") ||
        a.scope.localeCompare(b.scope) ||
        (a.company || "").localeCompare(b.company || "") ||
        b.versionNumber - a.versionNumber ||
        a.path.localeCompare(b.path),
    );
  const chosen =
    state.documents.find((d) => d.id === selected) ||
    (!selected
      ? list.find(
          (d) =>
            d.status === "current" &&
            d.scope === "general" &&
            d.format === "pdf",
        )
      : undefined);
  useEffect(() => {
    setComparison(null);
    setCompareId("");
    setTab("preview");
  }, [chosen?.id]);
  return (
    <>
      <div className="filter-panel">
        <div className="filter-top">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search versions, filenames, or employers…"
          />
          <Select
            label="Purpose"
            value={scope}
            onChange={setScope}
            options={[
              ["", "All purposes"],
              ...Array.from(new Set(state.documents.map((d) => d.scope))).map(
                (s) => [s, stageLabel(s)] as [string, string],
              ),
            ]}
          />
          <Select
            label="Document"
            value={kind}
            onChange={setKind}
            options={[
              ["", "All documents"],
              ...Array.from(new Set(state.documents.map((d) => d.kind))).map(
                (s) => [s, documentKindLabel(s)] as [string, string],
              ),
            ]}
          />
          <Select
            label="Privacy"
            value={privacy}
            onChange={setPrivacy}
            options={[
              ["", "All privacy variants"],
              ["private", "Private"],
              ["public", "Public"],
              ["unknown", "Unknown"],
            ]}
          />
        </div>
      </div>
      <div className="results-bar">
        <span>
          <strong>{list.length}</strong> cataloged artifacts
          <InfoTooltip label="About document paths">Original source paths are preserved.</InfoTooltip>
        </span>
      </div>
      <div className="document-layout">
        <section className="panel document-list" aria-label="Document versions">
          {list.map((d, i) => (
            <React.Fragment key={d.id}>
              {(i === 0 ||
                `${list[i - 1].scope}:${list[i - 1].company}` !==
                  `${d.scope}:${d.company}`) && (
                <h3 className="document-group">
                  {d.scope === "general"
                    ? "General resumes"
                    : d.company || stageLabel(d.scope)}
                </h3>
              )}
              <div className="record-with-delete"><AppLink
                className={`document-row ${chosen?.id === d.id ? "selected" : ""}`}
                go={go} page={"documents"} id={d.id}
              >
                <span
                  className={`file-icon ${d.format === "pdf" ? "pdf" : ""}`}
                >
                  <FileText size={18} />
                  <small>{d.format}</small>
                </span>
                <span className="document-row-main">
                  <strong>
                    {d.version} · {documentKindLabel(d.kind)}
                  </strong>
                  <span className="file-name">{d.name}</span>
                  <span className="badge-row">
                    {!!state.personal[d.id]?.preferred && (
                      <Badge tone="green">Preferred for package</Badge>
                    )}
                    {Array.isArray(d.usedInApplications) &&
                      d.usedInApplications.length > 0 && (
                        <Badge tone="green">Used in application</Badge>
                      )}
                    <Badge
                      tone={
                        d.status === "current"
                          ? "green"
                          : /bad|rejected/.test(d.status)
                            ? "amber"
                            : "muted"
                      }
                    >
                      {d.status}
                    </Badge>
                    <Badge tone={d.privacy === "private" ? "amber" : "muted"}>
                      {d.privacy}
                    </Badge>
                  </span>
                </span>
                <ChevronRight size={14} />
              </AppLink><DeleteRecord kind="document" id={d.id} label={d.name} onDeleted={() => { if (selected === d.id) go("documents"); }} /></div>
            </React.Fragment>
          ))}
          {!list.length && (
            <Empty title="No matching documents">
              Try a different version or purpose.
            </Empty>
          )}
        </section>
        {chosen ? (
          <section className="panel document-view">
            <div className="document-view-header">
              <div>
                <span className="eyebrow">
                  {chosen.company || "GENERAL"} · {chosen.version}
                </span>
                <h2>{chosen.name}</h2>
                <div className="badge-row">
                  <Badge tone={chosen.status === "current" ? "green" : "muted"}>
                    {chosen.status}
                  </Badge>
                  <Badge
                    tone={chosen.privacy === "private" ? "amber" : "muted"}
                  >
                    {chosen.privacy}
                  </Badge>
                  <Badge tone="muted">{chosen.format.toUpperCase()}</Badge>
                </div>
              </div>
              <a
                className="button secondary"
                href={`${entityUrl("/api/documents", chosen.id)}/download`}
                download
              >
                <ArrowDownToLine size={15} /> Download {chosen.privacy}
              </a>
            </div>
            <div className="document-meta">
              <div>
                <span>
                  Authored / revised
                  <InfoTooltip label="About document dates">Dates retain their recorded source and uncertainty.</InfoTooltip>
                </span>
                <strong>{formatDate(chosen.authoredDate)}</strong>
                <small>{chosen.dateProvenance}</small>
              </div>
              <div>
                <span>
                  First imported
                  <InfoTooltip label="About first imported date">This date records when Fieldwork cataloged the artifact.</InfoTooltip>
                </span>
                <strong>
                  {formatDate(chosen.firstImportedAt)}
                </strong>
              </div>
              <div>
                <span>
                  Filesystem modified
                  <InfoTooltip label="About filesystem modified date">A filesystem modified date is weak evidence of authorship.</InfoTooltip>
                </span>
                <strong>
                  {formatDate(chosen.modifiedAt)}
                </strong>
              </div>
            </div>
            <div className="document-tabs">
              <button
                className={tab === "preview" ? "active" : ""}
                onClick={() => setTab("preview")}
              >
                Preview
              </button>
              <button
                className={tab === "source" ? "active" : ""}
                onClick={() => setTab("source")}
              >
                Readable source
              </button>
              <button
                className={tab === "history" ? "active" : ""}
                onClick={() => setTab("history")}
              >
                Version history
              </button>
              <button
                className={tab === "compare" ? "active" : ""}
                onClick={() => setTab("compare")}
              >
                <GitCompareArrows size={14} /> Compare
              </button>
            </div>
            {tab === "preview" ? (
              chosen.format === "pdf" ? (
                <div className="pdf-preview">
                  <PdfPreview
                    title={chosen.name}
                    src={`${entityUrl("/api/documents", chosen.id)}/file`}
                    downloadUrl={`${entityUrl("/api/documents", chosen.id)}/download`}
                  />
                  <p className="small muted">
                    <a
                      href={`${entityUrl("/api/documents", chosen.id)}/file`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open PDF in a separate tab
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <div className="document-source">
                  <pre>
                    {chosen.text ||
                      "No readable text is available for this format. Download the original artifact."}
                  </pre>
                </div>
              )
            ) : tab === "source" ? (
              <div className="document-source">
                <Source path={chosen.path} />
                <pre>
                  {chosen.text ||
                    "This artifact has no extracted source text. Select its matching Markdown or HTML variant from the catalog."}
                </pre>
              </div>
            ) : tab === "history" ? (
              <div className="document-history">
                <div className="heading-help">
                  <h3>Preserved revisions</h3>
                  <InfoTooltip label="About preserved revisions">Versions are ordered numerically. Dates describe their source evidence, not inferred authorship.</InfoTooltip>
                </div>
                {state.documents
                  .filter(
                    (d) =>
                      d.kind === chosen.kind &&
                      d.scope === chosen.scope &&
                      d.company === chosen.company &&
                      d.format === chosen.format &&
                      d.privacy === chosen.privacy,
                  )
                  .sort((a, b) => b.versionNumber - a.versionNumber)
                  .map((d) => (
                    <AppLink
                      key={d.id}
                      className="history-row"
                      go={go} page={"documents"} id={d.id}
                    >
                      <span className="history-node" />
                      <strong>{d.version}</strong>
                      <span>
                        {formatDate(d.authoredDate)}
                        <small>{d.dateProvenance}</small>
                      </span>
                      <Badge tone={d.status === "current" ? "green" : "muted"}>
                        {d.status}
                      </Badge>
                    </AppLink>
                  ))}
                {chosen.notesPath && (
                  <div className="revision-notes">
                    <h3>Revision notes</h3>
                    <Source path={chosen.notesPath} />
                    <SourceText path={chosen.notesPath} />
                  </div>
                )}
              </div>
            ) : (
              <div className="document-comparison">
                <div className="heading-help">
                  <h3>Compare content</h3>
                  <InfoTooltip label="About document comparison">Compare the selected artifact with another revision. Source formats provide the clearest text comparison.</InfoTooltip>
                </div>
                <div className="inline-form">
                  <select
                    aria-label="Compare against document"
                    value={compareId}
                    onChange={(e) => setCompareId(e.target.value)}
                  >
                    <option value="">Choose another version</option>
                    {state.documents
                      .filter(
                        (d) => d.id !== chosen.id && d.kind === chosen.kind,
                      )
                      .sort((a, b) => b.versionNumber - a.versionNumber)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.company || "General"} · {d.version} · {d.privacy} ·{" "}
                          {d.format}
                        </option>
                      ))}
                  </select>
                  <button
                    className="button secondary"
                    disabled={!compareId}
                    onClick={() => {
                      setCompareError("");
                      api(
                        `/api/documents/compare?a=${encodeURIComponent(compareId)}&b=${encodeURIComponent(chosen.id)}`,
                      )
                        .then(setComparison)
                        .catch((e) => setCompareError(e.message));
                    }}
                  >
                    Compare versions
                  </button>
                </div>
                {compareError && (
                  <div className="banner danger">{compareError}</div>
                )}
                {comparison && (
                  <>
                    <div className="diff-legend">
                      <span className="removed">− Older selection</span>
                      <span className="added">+ Current selection</span>
                    </div>
                    <pre className="diff-content">
                      {(comparison.changes || []).map((c: any, i: number) => (
                        <span
                          key={i}
                          className={
                            c.added ? "added" : c.removed ? "removed" : ""
                          }
                        >
                          {c.added ? "+ " : c.removed ? "− " : ""}
                          {c.value}
                        </span>
                      ))}
                    </pre>
                  </>
                )}
              </div>
            )}
            <div className="document-bottom">
              <Source path={chosen.path} />
              <div className="row-wrap">
                <button
                  className="button secondary"
                  onClick={() =>
                    agent({ documentIds: [chosen.id] }, "resume-revision")
                  }
                >
                  <Sparkles size={15} /> Work on this version
                </button>
                <button
                  className="text-button"
                  disabled={chosen.status === "rejected"}
                  onClick={() =>
                    mutate(`${entityUrl("/api/documents", chosen.id)}/status`, {
                      status: "preferred",
                      expectedHash: chosen.hash,
                    }).catch(() => {})
                  }
                >
                  {state.personal[chosen.id]?.preferred
                    ? "Preferred for next package"
                    : "Use for next package"}
                </button>
                <InfoTooltip label="About preferred package versions">A preferred package version does not replace a resume master. Current-master promotion requires a validated revision bundle.</InfoTooltip>
              </div>
            </div>
          </section>
        ) : (
          <section className="panel">
            <Empty title="Choose a document">
              View its original artifact, source text, and revision history.
            </Empty>
          </section>
        )}
      </div>
    </>
  );
}
export function SourceText({ path }: { path: string }) {
  const [text, setText] = useState("Loading source…");
  useEffect(() => {
    let ignore = false;
    api(`/api/source?path=${encodeURIComponent(path)}`, undefined, undefined, {
      responseType: "response",
    })
      .then((r) => {
        if (!r.ok) throw new Error("Source unavailable");
        return r.text();
      })
      .then((t) => {
        if (!ignore) setText(t);
      })
      .catch((e) => {
        if (!ignore) setText(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [path]);
  return <pre className="source-text">{text}</pre>;
}
