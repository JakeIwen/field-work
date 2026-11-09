import { useState } from "react";
import { Bookmark, CheckCheck, Sparkles } from "lucide-react";
import type { PreparationScope } from "../../shared/application-preparation";
import { preparationDefaultParallelRuns } from "../../shared/preparation-settings";
import { answersOnlyGestureTitle, preventShiftTextSelection } from "../preparation/preparation-request";
import { selectedPreparationTargets, preparationSkipSummary } from "./opening-preparation-targets";
import type { AppState } from "../../shared/types";
import { entityUrl } from "../shell/entity-url";
import { runOpeningBulkRequests } from "./opening-bulk-requests";

type BulkKind = "reviewed" | "dismissed" | "saved";
type BulkProgress = { completed: number; total: number } | null;
const bulkLabels: Record<BulkKind, (n: number) => string> = {
  reviewed: n => `Marked ${n} reviewed`,
  dismissed: n => `Marked ${n} not interested`,
  saved: n => `Saved ${n}`,
};

async function generateSelectedDocuments(
  state: AppState,
  selectedSet: Set<string>,
  refresh: () => Promise<void>,
  announce: (message: string) => void,
  setProgress: (progress: BulkProgress) => void,
  scope: PreparationScope,
) {
  const { targets, skipped } = selectedPreparationTargets(state, selectedSet, scope);
  const skipSummary = preparationSkipSummary(skipped);
  if (!targets.length) { announce(["No selected openings need " + (scope === "answers" ? "answers" : "Generate Docs"), ...skipSummary].join(" · ")); return; }
  setProgress({ completed: 0, total: targets.length });
  const result = await runOpeningBulkRequests(targets.map(o => ({
    id: o.id, path: `/api/openings/${encodeURIComponent(o.id)}/prepare`, body: scope === "answers" ? { scope } : {},
  })), refresh, completed => setProgress({ completed, total: targets.length }));
  // Accepted requests may still be queued; snapshot notices announce actual starts.
  announce([
    result.succeeded.length ? `${scope === "answers" ? "Answers-only" : "Generate Docs"} requests accepted: ${result.succeeded.length}` : "",
    ...skipSummary,
    result.failed ? `${result.failed} failed` : "",
    result.refreshFailed ? "Could not refresh the list; reload to see saved changes" : "",
  ].filter(Boolean).join(" · "));
  setProgress(null);
}

/** The shown rows that were not selected; selections hidden by the filters are dropped. */
export const invertedSelection = (selection: string[], visibleIds: string[]) => {
  const selected = new Set(selection);
  return visibleIds.filter(id => !selected.has(id));
};

export function OpeningBulkActions({ state, selection, setSelection, showDismissed, refresh, announce, hiddenSelected, visibleIds }: {
  state: AppState; selection: string[]; setSelection: React.Dispatch<React.SetStateAction<string[]>>;
  showDismissed: boolean; refresh: () => Promise<void>; announce: (message: string) => void;
  hiddenSelected: number; visibleIds: string[];
}) {
  const [progress, setProgress] = useState<BulkProgress>(null);
  const bulkBusy = progress !== null;
  const selectedSet = new Set(selection);
  async function bulk(kind: BulkKind) {
    const targets = state.openings.filter(o => {
      if (!selectedSet.has(o.id)) return false;
      const p = state.personal[o.id] || {};
      return kind === "reviewed" ? p.reviewedHash !== o.hash : kind === "dismissed" ? !p.dismissed : !p.saved;
    });
    if (!targets.length) { announce("No selected openings needed that change"); return; }
    setProgress({ completed: 0, total: targets.length });
    const result = await runOpeningBulkRequests(targets.map(o => {
      const fields = kind === "reviewed" ? { reviewedHash: o.hash } : kind === "dismissed" ? { dismissed: true } : { saved: true };
      return { id: o.id, path: entityUrl("/api/personal", o.id), body: { expectedVersion: state.personal[o.id]?.version || 0, ...fields } };
    }), refresh, completed => setProgress({ completed, total: targets.length }));
    if (kind === "dismissed" && !showDismissed) setSelection(ids => ids.filter(id => !result.succeeded.includes(id)));
    announce(`${bulkLabels[kind](result.succeeded.length)}${result.failed ? ` · ${result.failed} failed` : ""}${result.refreshFailed ? " · Could not refresh the list; reload to see saved changes" : ""}`);
    setProgress(null);
  }
  if (!selection.length) return null;
  return (

        <div className="opening-bulk-bar" role="toolbar" aria-label="Actions for selected openings">
          <span className="opening-bulk-count" aria-live="polite">
            <strong>{selection.length}</strong> selected
            {hiddenSelected > 0 && <span className="muted"> · {hiddenSelected} not shown</span>}
            {progress && <span> · {progress.completed} of {progress.total} processed</span>}
          </span>
          <button className="button secondary small-button" disabled={bulkBusy} onClick={() => bulk("reviewed")}>
            <CheckCheck size={14} /> Mark reviewed
          </button>
          <button className="button secondary small-button" disabled={bulkBusy} onClick={() => bulk("dismissed")}>
            Not interested
          </button>
          <button className="button secondary small-button" disabled={bulkBusy}
            onMouseDown={preventShiftTextSelection}
            onClick={event => generateSelectedDocuments(state, selectedSet, refresh, announce, setProgress, event.shiftKey ? "answers" : "full")}
            title={`Skips ready or running openings; up to ${state.settings.parallelPreparations ?? preparationDefaultParallelRuns} preparations run at once, the rest queue. ${answersOnlyGestureTitle}`}>
            <Sparkles size={14} /> Generate Docs
          </button>
          <button className="button secondary small-button" disabled={bulkBusy} onClick={() => bulk("saved")}>
            <Bookmark size={14} /> Save
          </button>
          <button className="button secondary small-button" disabled={bulkBusy} onClick={() => setSelection(ids => invertedSelection(ids, visibleIds))}
            title="Select the shown openings that aren't selected and clear the ones that are. Openings hidden by the current filters are left unselected.">
            Invert selection
          </button>
          <button className="text-button" disabled={bulkBusy} onClick={() => setSelection([])}>
            Clear selection
          </button>
        </div>
  );
}
