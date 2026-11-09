import { greenhouseSearchIdentity } from "../../shared/greenhouse-search";
import { FIELDWORK_TIMEZONE } from "../../shared/timezone";
import DeleteRecord from "../ui/DeleteRecord";
import React, { useEffect, useState } from "react";
import { AlertTriangle, Download, LoaderCircle, Plus, RefreshCw } from "lucide-react";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import type { AppState } from "../../shared/types";
import { greenhouseDefaultParallelReviews, greenhousePullBlocksNewRun, type GreenhousePullSummary } from "../../shared/greenhouse-pull";
import { VALIDATION_RESULTS_HELP, ValidationOutcome, ValidationResults, ValidationRunning } from "./OpeningValidation";
import type { Go, Mutate } from "../workspace/workspace-actions";
import { taskBusy } from "./OpeningWorkflow";
import { PullGuidance } from "./pull-guidance/PullGuidance";
import { PullConditionsSummary } from "./pull-guidance/PullConditionsSummary";
import { greenhousePullPolicy } from "../../shared/greenhouse-policy";
import { tunableValue } from "../../shared/tunables";
import { PullActivity } from "./PullActivity";
import { PullMetrics } from "./pull-metrics/PullMetrics";
import { pullCountDefinitions } from "./pull-summary-content";

const PULL_DELETE_TITLE = "Delete this pull's run, candidate ledger and review conversations. Openings it added stay. To end a pull without losing anything, use Stop pull instead.";
const PULL_HINT = "The agent researches unsaved remote software roles on Greenhouse using the saved conditions below; an unknown original-publication date stays unknown. Greenhouse uses signed-in Chrome. You can leave this page while it works.";
function pullStatusLabel(status: GreenhousePullSummary["status"]) {
  return status === "target_reached" ? "Target reached" : status === "exhausted" ? "Selected coverage finished" : status === "stopped" ? "Stopped"
    : status === "finishing" ? "Finishing reviews" : status === "paused" ? "Paused" : status === "failed" ? "Needs attention" : status === "cooldown" ? "Cooling down" : "Working";
}

function pullPacingLabel(run: GreenhousePullSummary) {
  const current = run.finalPacingRate ?? run.pacingRate;
  if (current === undefined) return "";
  const initial = run.initialPacingRate ?? current;
  return initial === current ? `${(current / 1000).toFixed(1)} s, unchanged`
    : `${(initial / 1000).toFixed(1)} s → ${(current / 1000).toFixed(1)} s`;
}

function PullRunSummary({ run, state, go, active, running, open, setOpen, controls }: {
  run: GreenhousePullSummary; state: AppState; go: Go; active: boolean; running: boolean;
  open: boolean; setOpen: (open: boolean) => void; controls: React.ReactNode;
}) {
  const runningReviews = run.reviews?.filter(review => review.status === "running").length ?? 0;
  const reviewLimit = run.effectiveParallelReviews ?? state.settings.parallelReviews ?? greenhouseDefaultParallelReviews;
  return <details className="intake-summary" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      {running && <LoaderCircle size={13} className="spin" />} Pull · {run.legacySources ? "Earlier sources" : "Greenhouse"} · {run.added} of {run.target} added · {pullStatusLabel(run.status)}
      {(running || runningReviews > 0) && ` · ${runningReviews} of ${reviewLimit} reviews running`}
      {active && <progress value={run.added} max={run.target} aria-label="New openings added" />}
    </summary>
    <div className="intake-body">
      <div className="intake-links">{controls}<DeleteRecord kind="greenhouse_pull_run" id={run.id} label="listing pull" title={PULL_DELETE_TITLE} /></div>
      <p>{run.phase}</p>
      <PullConditionsSummary policy={run.policy} captured legacy={run.legacySources} />
      {run.guidance?.instructions && <details><summary>Instructions used for this pull</summary><p className="pull-guidance-snapshot">{run.guidance.instructions}</p></details>}
      {active && !run.reviews?.length && run.currentTitle && !run.phase.includes(run.currentTitle) && <p>{run.currentTitle}</p>}
      <p>{run.discovered} discovered · {run.reviewed} researched · {run.existing} already saved · {run.excluded} excluded · {run.deferred} deferred · {run.pending} remaining{run.remembered ? ` · ${run.remembered} reviewed in earlier pulls` : ""} <InfoTooltip label="About pull counts"><ul>{pullCountDefinitions.map(([term, definition]) => <li key={term}><strong>{term}:</strong> {definition}</li>)}</ul></InfoTooltip></p>
      <PullActivity activity={run.activity} go={go} runId={run.id} />
      {!!run.reviews?.length && <ul aria-label="Opening research reviews">
        {run.reviews.map(review => <li key={review.taskId}>
          <AppLink page="agents" id={review.taskId} go={go}>{review.title}</AppLink>
          {" · "}{review.status === "completed" ? "Ready to save" : review.status === "running" ? "Researching" : review.status}
        </li>)}
      </ul>}
      {!!run.searches?.length && <details><summary>Greenhouse search terms</summary><ul>
        {run.searches.map(search => <li key={greenhouseSearchIdentity(search).key}>{greenhouseSearchIdentity(search).label} · {search.pages ? `${search.pages} page${search.pages === 1 ? "" : "s"} checked${search.exhausted ? " · searched to the end" : ""}` : "Not searched yet"}</li>)}
      </ul></details>}
      {run.pacingRate && <p>Page interval: {pullPacingLabel(run)}{run.searchTransport === "userscript" ? " · MyGreenhouse userscript" : run.searchTransport === "navigation" ? " · Loading pages by URL" : ""}</p>}
      {run.parallelReviews !== undefined && <p>Parallel reviews: {run.parallelReviews}{run.searchLookahead !== undefined ? ` · Search lookahead: ${run.searchLookahead}` : ""}</p>}
      {run.searchTransportNote && <p>{run.searchTransportNote}</p>}
      {run.retryAt && <p>Next retry after {new Date(run.retryAt).toLocaleTimeString("en-US", { timeZone: FIELDWORK_TIMEZONE })}. The pending page is preserved.</p>}
      {run.status === "failed" && !run.legacySources && <p className="intake-error">The last Greenhouse pull stopped. Retry continues from the saved page, or stop the pull to start a new one.</p>}
      {run.error && <p className="intake-error" role="alert">{run.error}</p>}
      <div className="intake-links">
        {run.taskId && !run.reviews?.some(review => review.taskId === run.taskId) && <AppLink className="text-button" page="agents" id={run.taskId} go={go}>Review details</AppLink>}
        <a className="text-button" href={`/api/greenhouse/pulls/${encodeURIComponent(run.id)}/ledger`} target="_blank" rel="noreferrer">Search ledger</a>
      </div>
      {run.addedOpeningIds.length > 0 && <details className="greenhouse-added"><summary>Added openings ({run.added})</summary>
        {run.addedOpeningIds.map((id, index) => { const opening = state.openings.find(candidate => candidate.id === id); return <AppLink key={id} page="openings" id={id} go={go}>{opening ? `${opening.company} · ${opening.title}` : `Opening ${index + 1}`}</AppLink>; })}
      </details>}
    </div>
  </details>;
}

function OpeningValidationSummary({ validation, state, go }: { validation: any; state: AppState; go: Go }) {
  if (!validation) return null;
  return <details className="intake-summary">
    <summary>
      {validation.status === "running" ? <><RefreshCw size={13} className="spin" /> Validating {validation.completed}/{validation.total}</>
        : ["interrupted", "failed"].includes(validation.status) ? <><AlertTriangle size={13} /> Validation interrupted {validation.completed}/{validation.total}</>
        : `Validation · ${validation.counts.open} open · ${validation.counts.closed} closed · ${validation.counts.unknown} unverified · ${new Date(validation.updatedAt || validation.startedAt).toLocaleDateString("en-US", { timeZone: FIELDWORK_TIMEZONE, month: "short", day: "numeric" })}`} <InfoTooltip label="About validation results">{VALIDATION_RESULTS_HELP}</InfoTooltip>
    </summary>
    <div className="intake-body">
      <DeleteRecord kind="opening_validation_run" id={validation.id} label="availability validation" /><ValidationOutcome run={validation} />
      <ValidationRunning run={validation} />
      {validation.error && <p role="alert">{validation.error}</p>}
      <ValidationResults run={validation} state={state} go={go} />
    </div>
  </details>;
}

function ImportStatuses({ imports, state, go, setUrl, dismiss }: {
  imports: AppState["tasks"]; state: AppState; go: Go;
  setUrl: (url: string | undefined) => void; dismiss: () => void;
}) {
  return <>{imports.map(task => <span key={task.id} className="intake-import">
    <DeleteRecord kind="task" id={task.id} label={task.title || "opening research"} /><span className="intake-import-title">{task.openingId ? state.openings.find(opening => opening.id === task.openingId)?.title ?? "Opening added" : task.importUrl}</span>
    {task.openingId ? <AppLink className="text-button" go={go} page="openings" id={task.openingId} onClick={dismiss}>Open</AppLink> : taskBusy(task) ? <span><LoaderCircle size={13} className="spin" /> Researching…</span> : <>
      <span>{task.error || "Research needs attention"}</span>
      <button type="button" className="text-button" onClick={() => setUrl(task.importUrl)}>Retry URL</button>
    </>}
    <AppLink className="text-button" go={go} page="agents" id={task.id}>Details</AppLink>
    {!taskBusy(task) && <button type="button" className="text-button" onClick={dismiss}>Dismiss</button>}
  </span>)}</>;
}

/** Compact Openings intake: add a posting URL, start a Greenhouse pull, and show collapsed run summaries. */
export default function OpeningIntake({ state, mutate, go }: { state: AppState; mutate: Mutate; go: Go }) {
  const [url, setUrl] = useState<string | undefined>("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [currentImportId, setCurrentImportId] = useState<string | null>(null);
  const [target, setTarget] = useState("10");
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");
  const [guidanceDirty, setGuidanceDirty] = useState(false);
  const imports = state.tasks.filter(task => task.preset === "opening-research" && !task.greenhousePull && (taskBusy(task) || task.id === currentImportId));
  const run = state.greenhousePull;
  const active = Boolean(run && greenhousePullBlocksNewRun(run.status));
  const finishing = run?.status === "finishing";
  const working = active || finishing;
  const running = Boolean(run && ["running", "cooldown"].includes(run.status));
  const [pullOpen, setPullOpen] = useState(working);
  useEffect(() => { setPullOpen(working); }, [run?.id, working]);

  async function addOpening(event: React.FormEvent) {
    event.preventDefault(); setAdding(true); setAddError("");
    try {
      const result = await mutate("/api/openings/import", { url, clientRequestId: crypto.randomUUID() });
      setUrl(""); setCurrentImportId(result.openingId ? null : result.id);
      if (result.openingId) go("openings", result.openingId);
    } catch (error) { setAddError(String(error)); } finally { setAdding(false); }
  }
  async function pull(action?: "pause" | "resume" | "stop" | "stop_reviews") {
    setPullError("");
    if (!action && guidanceDirty) { setPullError("Save or discard your pull instructions first."); return; }
    const nextTarget = Number(target);
    if (!action && (!Number.isInteger(nextTarget) || nextTarget < 1 || nextTarget > 100)) {
      setPullError("Choose between 1 and 100 new openings."); return;
    }
    if (action && !run) { setPullError("This pull is no longer available."); return; }
    setPulling(true);
    try {
      const path = action && run
        ? `/api/greenhouse/pulls/${encodeURIComponent(run.id)}/action`
        : "/api/greenhouse/pulls";
      await mutate(path, action ? { action } : { target: nextTarget, clientRequestId: crypto.randomUUID() });
    } catch (error) { setPullError(String(error)); } finally { setPulling(false); }
  }

  const failedPullTitle = run?.status === "failed" && active ? "Retry or stop the failed pull before starting a new pull." : undefined;
  const controls = run && (finishing
    ? <button type="button" className="button secondary" disabled={pulling} onClick={() => void pull("stop_reviews")}>Stop reviews ({run.pending} left)</button>
    : active && <>
      {!run.legacySources && <button type="button" className="text-button" disabled={pulling} onClick={() => void pull(running ? "pause" : "resume")}>{running ? "Pause" : run.status === "failed" ? "Retry" : "Resume"}</button>}
      <button type="button" className="text-button" disabled={pulling} title="Stop searching; all discovered candidates will finish review." onClick={() => void pull("stop")}>Stop pull</button>
    </>);
  return <section className="panel opening-intake" aria-label="Add openings">
    <div className="intake-row">
      <form className="intake-add" onSubmit={addOpening}>
        <label htmlFor="add-opening-url" className="sr-only">Job posting URL</label>
        <input id="add-opening-url" type="url" required placeholder="Paste a job posting URL · the agent researches it" value={url} onChange={event => setUrl(event.target.value)} />
        <button className="button primary" disabled={adding}>{adding ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />} {adding ? "Adding…" : "Add opening"}</button>
      </form>
      <span className="intake-divider" aria-hidden="true" />
      <form className="intake-pull" onSubmit={event => { event.preventDefault(); void pull(); }}>
        <label htmlFor="listing-pull-target" className="sr-only">New openings to pull</label>
        <input id="listing-pull-target" type="number" min="1" max="100" step="1" required value={active && run ? String(run.target) : target} disabled={active || pulling} title={failedPullTitle} onChange={event => setTarget(event.target.value)} />
        <button className="button secondary" disabled={active || pulling || guidanceDirty} title={guidanceDirty ? "Save or discard your pull instructions first." : failedPullTitle ?? PULL_HINT}>{running ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />} Pull listings</button>
      </form>
    </div>
    <PullConditionsSummary policy={greenhousePullPolicy(state.settings)} cardDateMarginDays={tunableValue(state.settings, "greenhouse.cardDateMarginDays")} />
    <PullGuidance state={state} mutate={mutate} onDirty={setGuidanceDirty} />
    {addError && <p role="alert" className="small intake-error">{addError}</p>}
    <PullMetrics go={go} />
    {pullError && <p role="alert" className="small intake-error">{pullError}</p>}
    <div className="intake-status small muted" aria-live="polite">
      <OpeningValidationSummary validation={state.openingValidation as any} state={state} go={go} />
      {run && <PullRunSummary run={run} state={state} go={go} active={working} running={running || finishing} open={pullOpen} setOpen={setPullOpen} controls={controls} />}
      {run && working && !pullOpen && <span className="intake-links">{controls}</span>}
      <ImportStatuses imports={imports} state={state} go={go} setUrl={setUrl} dismiss={() => setCurrentImportId(null)} />
    </div>
  </section>;
}
