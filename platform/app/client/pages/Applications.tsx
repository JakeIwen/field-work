import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import { applicationSort, applicationSortOptions, sortApplications } from "../applications/application-sort";
import { useEffect, useState, type ReactNode } from "react";
import { ApplicationDetail } from "../applications/ApplicationDetail";
import { FollowUpEmailButton } from "../applications/FollowUpEmailButton";
import { suggestedAction } from "../applications/suggested-action";
import { useApplicationVisibility } from "../applications/ApplicationVisibility";
import { ArrowRight, Columns3, List, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import type { AppState, Application } from "../../shared/types";
import { api } from "../workspace/api";
import { entityUrl } from "../shell/entity-url";
import { formatDate } from "../ui/dates";
import { stageNames, stageLabel } from "../applications/stages";
import { readStored, writeStored } from "../workspace/browser-storage";
import type { Go, Mutate, Notify } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import type { ResumeVariantReport } from "../../shared/reports";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";

function NextAction({ application: a }: { application: Application }) {
  if (a.nextAction) return <>{a.nextAction}</>;
  const hint = suggestedAction(a);
  return hint ? <span className="suggested-action">Suggested: {hint}</span> : <span className="muted">Not set</span>;
}
const stageTone = (status: string) =>
  status === "ready" || status === "offer" ? "green" : status === "applied" || status === "interviewing" ? "blue" : "muted";
const appliedRule = "Applied is set when you record the submission. Open the application and use Record application sent.";
type View = "list" | "board";
const viewKey = "fieldwork.applications.view";

function ApplicationBoard({
  applications,
  state,
  selected,
  go,
  mutate,
  notify,
  stage,
}: {
  applications: Application[];
  state: AppState;
  selected: string;
  go: Go;
  mutate: Mutate;
  notify: Notify;
  stage: Application["status"] | "";
}) {
  const [dragging, setDragging] = useState(""),
    [over, setOver] = useState("");
  const move = (a: Application, stage: string) => {
    if (stage === a.status) return;
    if (stage === "applied" && !a.submittedAt) {
      notify(appliedRule);
      return;
    }
    mutate(entityUrl("/api/applications", a.id), { expectedVersion: a.version, status: stage }, "PATCH")
      .then(() => notify(`Moved to ${stageLabel(stage)}`))
      .catch(() => {});
  };
  return (
    <div className="kanban" role="region" aria-label="Applications by stage">
      {stageNames.filter(value => stage ? value === stage : value !== "rejected").map((stage) => {
        const cards = applications.filter((a) => a.status === stage);
        return (
          <section
            key={stage}
            className={`kanban-column ${over === stage ? "drop-target" : ""}`}
            aria-labelledby={`kanban-${stage}`}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (over !== stage) setOver(stage);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver("");
            }}
            onDrop={(e) => {
              e.preventDefault();
              const a = applications.find((x) => x.id === (dragging || e.dataTransfer.getData("application/x-fieldwork-id")));
              setDragging("");
              setOver("");
              if (a) move(a, stage);
            }}
          >
            <h3 id={`kanban-${stage}`}>
              {stageLabel(stage)} <span>{cards.length}</span>
            </h3>
            <div className="kanban-cards">
              {cards.map((a) => {
                const o = state.openings.find((o) => o.id === a.openingId);
                const name = `${o?.company || "Unlinked company"} · ${o?.title || a.openingId}`;
                return (
                  <article
                    key={a.id}
                    className={`kanban-card ${a.id === selected ? "selected" : ""} ${dragging === a.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("application/x-fieldwork-id", a.id);
                      setDragging(a.id);
                    }}
                    onDragEnd={() => {
                      setDragging("");
                      setOver("");
                    }}
                  >
                    <AppLink className="table-role kanban-link" go={go} page={"applications"} id={a.id} draggable={false}>
                      <span className="row-company">{o?.company || "Unlinked company"}</span>
                      <strong>{o?.title || a.openingId}</strong>
                    </AppLink>
                    <div className="kanban-meta small">
                      <NextAction application={a} />
                    </div>
                    <div className="kanban-foot"><DeleteRecord kind="application" id={a.id} label={name} onDeleted={() => { if (selected === a.id) go("applications"); }} />
                      <span className="tiny muted">{a.followUp ? `Follow-up ${formatDate(a.followUp)}` : "No follow-up"}</span>
                      <FollowUpEmailButton application={a} followUp={state.followUps?.find((f) => f.applicationId === a.id)} label={name} go={go} notify={notify} />
                      <select
                        className="kanban-stage"
                        aria-label={`Stage for ${name}`}
                        value={a.status}
                        onChange={(e) => move(a, e.target.value)}
                      >
                        {stageNames.map((s) => (
                          <option key={s} value={s}>{stageLabel(s)}</option>
                        ))}
                      </select>
                    </div>
                  </article>
                );
              })}
              {!cards.length && <p className="kanban-empty tiny muted">{dragging ? "Drop here" : "None"}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type ReportState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; report: ResumeVariantReport };

function ResumeVariantOutcomes({ state, go }: { state: AppState; go: Go }) {
  const [report, setReport] = useState<ReportState | null>(null);
  const load = () => {
    setReport({ status: "loading" });
    api("/api/reports/resume-variants", undefined, undefined, {
      headers: { Accept: "application/json" },
      responseType: "response",
    })
      .then(async (response) => {
        if (response.status === 404) return setReport({ status: "missing" });
        const json = response.headers.get("content-type")?.includes("json");
        if (!json) return setReport({ status: "missing" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
        if (!Array.isArray(body?.rows)) return setReport({ status: "missing" });
        setReport({ status: "ready", report: body });
      })
      .catch((e) => setReport({ status: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  let body: ReactNode = null;
  if (report?.status === "loading") body = <p className="small muted" role="status"><LoaderCircle size={14} className="spin" /> Loading report…</p>;
  else if (report?.status === "missing") body = <p className="small muted">Report not available yet.</p>;
  else if (report?.status === "error") body = <p className="small" role="alert">Could not load the report: {report.message}</p>;
  else if (report?.status === "ready") {
    const { rows, applicationsWithoutPackage, generatedAt } = report.report;
    body = (
      <>
        <p className="tiny muted">
          Based on documents saved with each submission. Generated {formatDate(generatedAt, true)}.
          {applicationsWithoutPackage > 0 && ` ${applicationsWithoutPackage} applications have no saved documents and are not counted.`}
        </p>
        {rows.length ? (
          <div className="table-scroll">
            <table className="variant-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Privacy</th>
                  <th>Generated</th>
                  <th>Applications</th>
                  <th>Stages</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.documentId + row.hash}>
                    <td><strong>{row.label}</strong></td>
                    <td><Badge tone={row.privacy === "private" ? "amber" : "muted"}>{row.privacy}</Badge></td>
                    <td className="small">{row.generatedAt ? formatDate(row.generatedAt) : "Unknown"}</td>
                    <td>
                      {row.applications.length ? (
                        <details className="variant-applications">
                          <summary>{row.applications.length}</summary>
                          <ul>
                            {row.applications.map((app) => (
                              <li key={app.applicationId}>
                                <AppLink className="text-button" go={go} page={"applications"} id={app.applicationId}>
                                  {app.company} · {app.title}
                                </AppLink>{" "}
                                <span className="tiny muted">{stageLabel(app.stage)}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : "0"}
                    </td>
                    <td>
                      <span className="badge-row">
                        {Object.entries(row.stageCounts).filter(([, n]) => n > 0).map(([stage, n]) => (
                          <Badge key={stage} tone={stageTone(stage)}>{stageLabel(stage)} {n}</Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">No submitted applications with saved documents yet.</p>
        )}
      </>
    );
  }
  return (
    <details
      className="panel variant-report"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && !report) load();
      }}
    >
      <summary>
        <span>Outcomes by resume version</span>
      </summary>
      <div className="panel-body">
        {body}
        {report && report.status !== "loading" && (
          <button type="button" className="text-button" onClick={load}>
            <RefreshCw size={13} aria-hidden="true" /> Refresh report
          </button>
        )}
      </div>
    </details>
  );
}

function applicationSortHeader(sort: ReturnType<typeof applicationSort>, setSort: (value: ReturnType<typeof applicationSort>) => void, label: string, asc: ReturnType<typeof applicationSort>, desc: ReturnType<typeof applicationSort>) {
    const direction = sort === asc ? "ascending" : sort === desc ? "descending" : "none";
    const next = sort === asc ? desc : asc;
    return <th aria-sort={direction}><button type="button" className="opening-sort-header" onClick={() => setSort(next)} aria-label={`Sort by ${label.toLowerCase()}: ${next === asc ? "ascending" : "descending"}`}>
      {label}<span aria-hidden="true">{direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}</span>
    </button></th>;
  }

export function Applications({
  state,
  selected,
  go,
  mutate,
  agent,
  notify,
}: {
  state: AppState;
  selected: string;
  go: Go;
  mutate: Mutate;
  agent: (c: Partial<Context>, p?: string) => void;
  notify: Notify;
}) {
  const [view, setView] = useState<View>(() => (readStored(viewKey) === "board" ? "board" : "list"));
  const visibility = useApplicationVisibility(state.applications);
  const chooseView = (next: View) => {
    setView(next);
    writeStored(viewKey, next);
  };
  const [create, setCreate] = useState(false),
    [opening, setOpening] = useState("");
  const [sort, setSort] = useState(()=>{
    try{return applicationSort(localStorage.getItem("fieldwork.applications.sort.v2"));}catch{return applicationSort(null);}
  });
  useEffect(()=>{try{localStorage.setItem("fieldwork.applications.sort.v2",sort);}catch{/* Sorting remains usable without browser storage. */}},[sort]);
  const applications = sortApplications(visibility.visible,state.openings,sort,stageNames,a=>a.nextAction || suggestedAction(a));
  const sortHeader = applicationSortHeader.bind(null, sort, setSort);
  const chosen = state.applications.find((a) => a.id === selected);
  return (
    <>
      <div className="page-toolbar application-toolbar">
        {visibility.control}
        <div className="application-controls">
          <div className="view-toggle" role="group" aria-label="Applications view">
            <button type="button" aria-pressed={view === "list"} className={view === "list" ? "selected" : ""} onClick={() => chooseView("list")}>
              <List size={14} aria-hidden="true" /> List
            </button>
            <button type="button" aria-pressed={view === "board"} title="Drag a card or use its stage menu to move it." className={view === "board" ? "selected" : ""} onClick={() => chooseView("board")}>
              <Columns3 size={14} aria-hidden="true" /> Board
            </button>
          </div>
          <label className="opening-sort"><span>Sort by</span><select aria-label="Sort applications" value={sort} onChange={e=>setSort(applicationSort(e.target.value))}>
            {applicationSortOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select></label>
          <button className="button primary" onClick={() => setCreate(!create)}>
            <Plus size={15} /> New application
          </button>
        </div>
      </div>
      {create && (
        <form
          className="panel inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutate("/api/applications", { openingId: opening })
              .then((a) => {
                setCreate(false);
                go("applications", a.id || a.application?.id);
              })
              .catch(() => {});
          }}
        >
          <label className="grow">
            Opening
            <select
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              required
            >
              <option value="">Select a researched opening</option>
              {state.openings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.company} · {o.title}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary">Create draft application</button>
        </form>
      )}
      {!state.applications.length ? (
        <section className="panel">
          <Empty title="Start with a role worth pursuing">
            <p>
              Build a draft package, keep the next step in view, and preserve
              the exact files when you record an application sent.
            </p>
            <p>
              Existing tailored documents do not mean an application was
              submitted.
            </p>
            <AppLink className="button primary" go={go} page={"openings"}>
              Browse opportunities <ArrowRight size={15} />
            </AppLink>
          </Empty>
        </section>
      ) : (
        <div
          className={`master-detail ${chosen ? "has-detail application-layout" : ""}`}
        >
          {view === "board" ? (
            <section className="panel table-panel board-panel">
              <ApplicationBoard applications={applications} state={state} selected={selected} go={go} mutate={mutate} notify={notify} stage={visibility.stage} />
            </section>
          ) : (
          <section className="panel table-panel">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {sortHeader("Application", "company", "company-desc")}
                    {sortHeader("Stage", "stage", "stage-desc")}
                    {sortHeader("Submitted", "submitted-asc", "submitted")}
                    {!chosen && sortHeader("Next action", "next-action", "next-action-desc")}
                    {sortHeader("Follow-up", "followup", "followup-desc")}
                  </tr>
                </thead>
                <tbody>
                  {!applications.length && <tr><td colSpan={chosen ? 4 : 5} className="muted">{!visibility.stage && visibility.rejectedCount ? "No active applications. Select Rejected to see earlier outcomes." : "No applications in this stage."}</td></tr>}
                  {applications.map((a) => {
                      const o = state.openings.find(
                        (o) => o.id === a.openingId,
                      );
                      return (
                        <tr
                          key={a.id}
                          data-application-id={a.id}
                          className={a.id === selected ? "selected" : ""}
                        >
                          <td>
                            <AppLink
                              className="table-role"
                              go={go} page={"applications"} id={a.id}
                            >
                              <span className="row-company">
                                {o?.company || "Unlinked company"}
                              </span>
                              <strong>{o?.title || a.openingId}</strong>
                            </AppLink>
                          </td>
                          <td>
                            <Badge tone={stageTone(a.status)}>
                              {stageLabel(a.status)}
                            </Badge>
                          </td>
                          <td className="small">{a.submittedAt ? formatDate(a.submittedAt) : "—"}</td>
                          {!chosen && (
                            <td>
                              <NextAction application={a} />
                            </td>
                          )}
                          <td className="small">
                            <span className="follow-up-cell">
                              {a.followUp ? formatDate(a.followUp) : "Not set"}
                              <FollowUpEmailButton application={a} followUp={state.followUps?.find((f) => f.applicationId === a.id)}
                                label={`${o?.company || "Application"} · ${o?.title || a.openingId}`} go={go} notify={notify} />
                            </span>
                            <DeleteRecord kind="application" id={a.id} label={`${o?.company || "Application"} ${o?.title || a.openingId}`} onDeleted={() => { if (selected === a.id) go("applications"); }} />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
          )}
          {chosen && (
            <ApplicationDetail
              key={chosen.id}
              application={chosen}
              state={state}
              mutate={mutate}
              go={go}
              agent={agent}
            />
          )}
        </div>
      )}
      {view === "list" && state.applications.length > 0 && <ResumeVariantOutcomes state={state} go={go} />}
    </>
  );
}

export { ApplicationDetail, suggestedAction };
