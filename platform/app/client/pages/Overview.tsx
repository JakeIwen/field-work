import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import { ArrowRight, BriefcaseBusiness, Building2, Check, CheckCheck, ChevronRight, Clock3, FileText, FolderOpen, Sparkles, AlertTriangle, Activity } from "lucide-react";
import type { AppState } from "../../shared/types";
import { formatDate, calendarDate, addCalendarDays, dayOf } from "../ui/dates";
import { retained } from "../workspace/opening-selectors";
import { monitored } from "../workspace/company-selectors";
import { stageLabel } from "../applications/stages";
import { presets } from "../agents/task-presets";
import type { Go } from "../workspace/workspace-actions";
import type { Context } from "../agents/task-context";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Journal } from "../ui/Journal";

type TodayItem = {
  key: string;
  kind: string;
  title: string;
  detail: string;
  page: string;
  id: string;
  overdue?: boolean;
  tone?: "danger" | "warning" | "";
};
const closedStages = ["rejected", "withdrawn"];
/** Short single-line failure text without a repeated "Company · Role:" prefix. */
const compact = (text: string, prefix: string) => {
  const line = text.replace(prefix + ":", "").replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
};
/** One ordered queue of what needs attention today, deduplicated by target. */
export function todayQueue(state: AppState): TodayItem[] {
  const today = calendarDate(state.settings.timezone);
  const soon = addCalendarDays(today, 3);
  const deadlineLimit = addCalendarDays(today, 14);
  const openingOf = (id: string) => state.openings.find((o) => o.id === id);
  const role = (openingId: string) => {
    const o = openingOf(openingId);
    return o ? `${o.company} · ${o.title}` : "Application";
  };
  const active = state.applications.filter((a) => !closedStages.includes(a.status));
  const byDate = <T,>(rows: T[], date: (row: T) => string) =>
    [...rows].sort((x, y) => date(x).localeCompare(date(y)));
  const followUp = (day: string) => (day < today ? `overdue since ${formatDate(day)}` : "due today");
  const groups: TodayItem[][] = [
    // 1. Follow-ups due today or earlier (applications, then opening notes).
    [
      ...byDate(active.filter((a) => dayOf(a.followUp) && dayOf(a.followUp) <= today), (a) => dayOf(a.followUp)).map((a) => ({
        key: `applications:${a.id}`,
        kind: "Follow up",
        title: role(a.openingId),
        detail: [a.nextAction, followUp(dayOf(a.followUp))].filter(Boolean).join(" · "),
        page: "applications",
        id: a.id,
        overdue: dayOf(a.followUp) < today,
      })),
      ...byDate(
        retained(state).filter((o) => {
          const day = dayOf(String(state.personal[o.id]?.followUp || ""));
          return day && day <= today && !state.personal[o.id]?.dismissed;
        }),
        (o) => dayOf(String(state.personal[o.id]?.followUp || "")),
      ).map((o) => {
        const day = dayOf(String(state.personal[o.id]?.followUp || ""));
        return {
          key: `openings:${o.id}`,
          kind: "Follow up",
          title: `${o.company} · ${o.title}`,
          detail: [String(state.personal[o.id]?.nextAction || ""), followUp(day)].filter(Boolean).join(" · "),
          page: "openings",
          id: o.id,
          overdue: day < today,
        };
      }),
    ],
    // 2. Failed document generation.
    (state.preparations || [])
      .filter((r) => r.status === "failed")
      .map((r) => ({
        key: `openings:${r.openingId}`,
        kind: "Generation failed",
        title: role(r.openingId),
        detail: compact(r.error || r.message || "Retry Generate Docs on the opening", role(r.openingId)),
        page: "openings",
        id: r.openingId,
        tone: "danger" as const,
      })),
    // 3. Ready to submit.
    active
      .filter((a) => a.status === "ready")
      .map((a) => ({
        key: `applications:${a.id}`,
        kind: "Ready to submit",
        title: role(a.openingId),
        detail: a.nextAction || "Documents are ready",
        page: "applications",
        id: a.id,
      })),
    // 4. Saved next actions with a follow-up in the next three days.
    byDate(
      active.filter((a) => a.nextAction && dayOf(a.followUp) > today && dayOf(a.followUp) <= soon),
      (a) => dayOf(a.followUp),
    ).map((a) => ({
      key: `applications:${a.id}`,
      kind: "Next action",
      title: role(a.openingId),
      detail: `${a.nextAction} · ${formatDate(dayOf(a.followUp))}`,
      page: "applications",
      id: a.id,
    })),
    // 5. Deadlines from today through the next 14 days.
    byDate(
      retained(state).filter((o) => {
        const day = dayOf(o.deadline);
        return day && day >= today && day <= deadlineLimit && !state.personal[o.id]?.dismissed;
      }),
      (o) => dayOf(o.deadline),
    ).map((o) => ({
      key: `openings:${o.id}`,
      kind: "Deadline",
      title: `${o.company} · ${o.title}`,
      detail: dayOf(o.deadline) === today ? "Closes today" : formatDate(dayOf(o.deadline)),
      page: "openings",
      id: o.id,
      tone: "warning" as const,
    })),
    // 6. Unreviewed openings without an application.
    retained(state)
      .filter(
        (o) =>
          !state.personal[o.id]?.reviewedHash &&
          !state.personal[o.id]?.dismissed &&
          !state.applications.some((a: any) => a.openingId === o.id),
      )
      .slice(0, 5)
      .map((o) => ({
        key: `openings:${o.id}`,
        kind: "Review",
        title: `${o.company} · ${o.title}`,
        detail: "Not reviewed yet",
        page: "openings",
        id: o.id,
      })),
  ];
  const seen = new Set<string>();
  return groups.flat().filter((item) => !seen.has(item.key) && !!seen.add(item.key));
}

export function Overview({
  state,
  go,
  agent,
}: {
  state: AppState;
  go: Go;
  agent: (c: Partial<Context>, p?: string) => void;
}) {
  const saved = retained(state).filter(
    (o) => state.personal[o.id]?.saved && !state.personal[o.id]?.dismissed,
  );
  const unreviewed = retained(state).filter(
    (o) =>
      !state.personal[o.id]?.reviewedHash && !state.personal[o.id]?.dismissed,
  );
  const changed = retained(state).filter(
    (o) =>
      state.personal[o.id]?.reviewedHash &&
      state.personal[o.id].reviewedHash !== o.hash,
  );
  const active = state.applications.filter(
    (a) => !closedStages.includes(a.status),
  );
  const queue = todayQueue(state);
  const shown = queue.slice(0, 12);
  const current = state.documents
    .filter(
      (d) =>
        d.scope === "general" && d.kind === "resume" && d.status === "current",
    )
    .sort(
      (a, b) =>
        b.versionNumber - a.versionNumber ||
        Number(b.format === "pdf") - Number(a.format === "pdf"),
    )[0];
  return (
    <>
      <div className="stat-grid">
        <AppLink className="stat" go={go} page={"openings"}>
          <span>Retained opportunities</span>
          <strong>
            {retained(state).length}
            <BriefcaseBusiness size={23} />
          </strong>
          <small>{unreviewed.length} awaiting your review</small>
        </AppLink>
        <AppLink className="stat" go={go} page={"companies"}>
          <span>Companies monitored</span>
          <strong>
            {monitored(state).length}
            <Building2 size={23} />
          </strong>
          <small>
            {state.scan.failedCompanies.length} employers have incomplete checks in the latest
            scan
          </small>
        </AppLink>
        <AppLink className="stat" go={go} page={"applications"}>
          <span>Active applications</span>
          <strong>
            {active.length}
            <FolderOpen size={23} />
          </strong>
          <small>{saved.length} bookmarked opportunities</small>
        </AppLink>
        <AppLink className="stat" go={go} page={"documents"} id={current?.id}
          title={current ? "Browse source, PDF & earlier revisions" : "Check document source authority"}>
          <span>Current general resume</span>
          <strong className="version-stat">
            {current?.version || "Unknown"}
            <FileText size={23} />
          </strong>
        </AppLink>
      </div>
      <section className="panel today-panel" aria-labelledby="today-heading">
        <div className="section-heading">
          <div>
            <h2 id="today-heading">Today</h2>
          </div>
          <Clock3 size={18} className="muted" aria-hidden="true" />
        </div>
        {shown.length ? (
          <ol className="today-list">
            {shown.map((item) => (
              <li key={item.key}>
                <AppLink
                  className={`action-row today-row ${item.overdue ? "overdue" : ""} ${item.tone || ""}`}
                  go={go} page={item.page} id={item.id}
                >
                  <span className="today-kind">
                    {item.kind}
                    {item.overdue && <span className="today-flag">Overdue</span>}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </AppLink>
              </li>
            ))}
          </ol>
        ) : (
          <div className="quiet-empty">
            <p>Nothing due today.</p>
            <span>Follow-ups, ready applications and near deadlines will appear here.</span>
          </div>
        )}
        {queue.length > shown.length && (
          <div className="today-more">
            <AppLink className="text-button" go={go} page={"applications"}>
              {queue.length - shown.length} more <ArrowRight size={14} />
            </AppLink>
          </div>
        )}
      </section>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Worth a closer look</h2>
            </div>
            <AppLink className="text-button" go={go} page={"openings"}>
              All openings <ArrowRight size={14} />
            </AppLink>
          </div>
          {unreviewed.slice(0, 4).map((o) => (
            <AppLink
              className="opportunity-row"
              key={o.id}
              go={go} page={"openings"} id={o.id}
            >
              <span className="company-avatar">
                {o.company.slice(0, 2).toUpperCase()}
              </span>
              <span className="opportunity-main">
                <span className="row-company">{o.company}</span>
                <strong>{o.title}</strong>
                <span className="muted line-clamp">{o.location}</span>
                <span className="row-pay line-clamp">{o.compensation}</span>
              </span>
              <span className="row-end">
                <ChevronRight size={17} />
              </span>
            </AppLink>
          ))}
          {!unreviewed.length && (
            <Empty icon={CheckCheck} title="You are caught up">
              Revisit saved roles or research a company.
            </Empty>
          )}
        </section>
        <div className="stack">
          <section className="panel agent-card">
            <Sparkles size={22} />
            <h2>A second set of eyes</h2>
            {state.tasks
              .slice(-2)
              .reverse()
              .map((t) => (
                <AppLink
                  className="agent-activity-row"
                  key={t.id}
                  go={go} page={[
                        "questions",
                        "posting-cover-letter",
                        "posting-resume",
                      ].includes(t.preset)
                        ? "questions"
                        : "agents"} id={t.id}
                >
                  <span>{t.title || presets[t.preset]?.title || t.preset}</span>
                  <Badge tone={t.status === "completed" ? "green" : "muted"}>
                    {stageLabel(t.status)}
                  </Badge>
                </AppLink>
              ))}
            <button
              className="button secondary"
              onClick={() => agent({}, "resume-revision")}
            >
              Open agent workspace <ArrowRight size={15} />
            </button>
          </section>
        </div>
      </div>
      <div className="overview-grid lower-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Research freshness</h2>
              <p>
                Careers scan:{" "}
                {formatDate(
                  state.scan.timestamp,
                  true,
                )}
              </p>
            </div>
          </div>
          <div className="panel-body">
            <div className="banner warning">
              <AlertTriangle size={18} />
              <span>
                {state.scan.failedCompanies.length
                  ? `${state.scan.failedCompanies.length} employers have incomplete checks. See individual posting results; gaps do not establish closure.`
                  : "Source dates describe the last scan, not a live guarantee that a posting is open."}
              </span>
            </div>
            <p className="small muted">
              {state.scan.seenCount.toLocaleString()} ATS identities in scan
              history <InfoTooltip label="About scan history">ATS identities are historical discovery records, separate from retained opportunities.</InfoTooltip> · {retained(state).length} retained opportunities
            </p>
            {changed.length > 0 && (
              <AppLink className="text-button" go={go} page={"openings"}>
                {changed.length} roles changed since your last review
              </AppLink>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Recent activity</h2>
            </div>
            <Activity size={18} className="muted" />
          </div>
          <Journal
            entries={state.journal.slice(0, 5)}
          />
        </section>
      </div>
    </>
  );
}
