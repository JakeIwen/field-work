import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import React from "react";
import { RefreshCw, Check, AlertTriangle } from "lucide-react";
import type { AppState } from "../../shared/types";
import { isActiveOpening, validationLabel } from "../../shared/opening-availability";
import { formatDate } from "../ui/dates";
import { type Go } from "../workspace/workspace-actions";
type Props = { state: AppState; mutate: (url: string, body: any) => Promise<any> };
export const VALIDATION_RESULTS_HELP = "Checks employer availability, not posting age. An inconclusive recheck preserves existing visibility; previously confirmed closures remain hidden.";
export function ValidateOpeningsButton({ state, mutate }: Props) {
  const [pending, setPending] = React.useState(false);
  const run = state.openingValidation as any;
  const running = run?.status === "running";
  const resume = ["interrupted", "failed"].includes(run?.status);
  return <button className="button secondary" disabled={pending || running || (!resume && !state.openings.some(o => isActiveOpening(o) && !state.personal[o.id]?.dismissed))}
    title="Check existing active postings on employer sites, skipping Not interested ones. Confirmed removals are hidden; inconclusive checks preserve existing visibility, so previously closed postings remain hidden."
    onClick={async () => {
      setPending(true);
      try { await mutate(`/api/opening-validation${resume ? "/resume" : ""}`, {}); }
      catch { /* App displays the request error. */ }
      finally { setPending(false); }
    }}>
    <RefreshCw size={15} className={running || pending ? "spin" : ""} />
    {running ? `Validating ${run.completed}/${run.total}` : resume ? `Resume validation ${run.completed}/${run.total}` : "Validate openings"}
  </button>;
}

/** Visibility outcome of a finished run; shared by the global banner and the Openings intake summary. */
export function ValidationOutcome({ run }: { run: any }) {
  if (run.status === "running") return null;
  return <>
    {run.visibilityChanges && <div className="small">
      {run.visibilityChanges.hidden || run.visibilityChanges.restored
        ? `${run.visibilityChanges.hidden} newly hidden from default lists · ${run.visibilityChanges.restored} restored to default lists.`
        : "No openings changed visibility."}
    </div>}
    <div className="small muted">Closed postings are hidden by default. Unresolved checks preserve existing visibility; previously closed postings remain hidden.</div>
  </>;
}

/** Progress bar and current item while a run is active. */
export function ValidationRunning({ run }: { run: any }) {
  if (run.status !== "running") return null;
  return <><progress value={run.completed} max={run.total} aria-label="Openings checked" /><p className="small muted">{run.current || "Starting…"} · You can navigate away while this runs.</p></>;
}

/** Per-opening validation results list. */
export function ValidationResults({ run, state, go }: { run: any; state: AppState; go: Go }) {
  return <>
    <p className="small muted">Checked {formatDate(run.updatedAt || run.startedAt, true)}.</p>
    <ul className="validation-results">
      {run.results.map((r: any) => {
        const o = state.openings.find(o => o.id === r.id);
        return <li key={r.id}>
          <AppLink className="text-button" go={go} page={"openings"} id={r.id}>{o ? `${o.company} · ${o.title}` : r.id}</AppLink>
          <span className="small">{validationLabel(r.status)} · {r.reason}</span>
          {r.sourceUrl && <a className="small" href={r.sourceUrl} target="_blank" rel="noreferrer">Check source</a>}
        </li>;
      })}
    </ul>
  </>;
}

/** Full validation banner, shown on other pages while a run is in progress. */
export function OpeningValidationProgress({ state, go }: { state: AppState; go: Go }) {
  const run = state.openingValidation as any;
  if (!run) return null;
  const running = run.status === "running";
  return <section className="opening-validation panel" aria-label="Opening validation">
    <div className={`banner ${run.counts.unknown || ["failed", "interrupted"].includes(run.status) ? "warning" : ""}`} role="status" aria-live="polite">
      {running ? <RefreshCw size={18} className="spin" /> : run.counts.unknown || run.status !== "completed" ? <AlertTriangle size={18} /> : <Check size={18} />}
      <div>
        <strong>{running ? `Validating openings · ${run.completed}/${run.total}` : run.status === "completed" ? `Checked ${run.completed} ${run.completed === 1 ? "opening" : "openings"}` : `Validation interrupted · ${run.completed}/${run.total}`}</strong>
        <div>{run.counts.open} confirmed open · {run.counts.closed} closed / removed · {run.counts.unknown} could not verify</div>
        <ValidationOutcome run={run} />
      </div>
    </div>
    <ValidationRunning run={run} />
    {run.error && <p role="alert">{run.error}</p>}
    <details>
      <summary>Validation results <InfoTooltip label="About validation results">{VALIDATION_RESULTS_HELP}</InfoTooltip></summary><DeleteRecord kind="opening_validation_run" id={run.id} label="availability validation" />
      <ValidationResults run={run} state={state} go={go} />
    </details>
  </section>;
}
