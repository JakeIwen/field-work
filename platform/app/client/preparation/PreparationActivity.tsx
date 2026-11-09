import React from "react";
import { preparationBusy, type ApplicationPreparation, type PreparationActivityResponse } from "../../shared/application-preparation";
import { recordedAgentLabel } from "../../shared/codex-models";
import type { TaskSummary } from "../../shared/types";
import InfoTooltip from "../ui/InfoTooltip";
import { useCodexModelCatalog } from "../workspace/CodexModelCatalog";
import {
  agentLine, elapsedInPhase, formatDuration, livenessPhrase, phaseDurations, preparationTask, turnLine, typicalDuration, SILENCE_THRESHOLD_MS,
} from "./preparation-activity-format";
import { useTick } from "./usePreparationActivity";
import "./preparation-activity.css";

type ActivityProps = {
  run: ApplicationPreparation;
  /** The state snapshot's tasks; the run's own tasks carry the saved activity. */
  tasks: readonly TaskSummary[];
  /** The polled live view, or null before the first answer or when idle. */
  activity: PreparationActivityResponse | null;
};

/** The run's task and the live turn the poll reports for it. */
function currentTurn({ run, tasks, activity }: ActivityProps) {
  const task = preparationTask(run, tasks);
  return { task, live: (task && activity?.tasks?.find(entry => entry.id === task.id)?.live) || null };
}

/**
 * The status message with the current phase's elapsed time and one liveness phrase. Everything
 * else about the turn is in PreparationActivityDetails; the explanations are in the tooltip.
 */
export function PreparationLiveLine({ message, runs, ...props }: ActivityProps & { message: string; runs: readonly ApplicationPreparation[] }) {
  const { run, tasks } = props;
  const busy = preparationBusy(run);
  const now = useTick(busy);
  const { task, live } = currentTurn(props);
  const elapsed = busy ? elapsedInPhase(run, now) : undefined;
  const phrase = busy ? livenessPhrase(live, task, now) : undefined;
  const typical = busy ? typicalDuration(runs, tasks, task?.model ? recordedAgentLabel(task.model) : undefined) : undefined;
  return <span className="preparation-live">
    {/* Only the stable message is a live region: the ticking figures beside it would be re-announced every second. */}
    <span role="status">{message}</span>
    {elapsed !== undefined && <span className="preparation-live-detail">{` · ${formatDuration(elapsed)}`}</span>}
    {phrase && <span className="preparation-live-detail">{` · ${phrase}`}</span>}
    {busy && <InfoTooltip label="About generation progress">{[
      'The time is how long this run has spent in its current phase. The phrase after it says what the model is doing right now.',
      `Models can think for several minutes without sending anything, so a quiet stretch is normal. "No signal" means nothing has arrived from the model for over ${formatDuration(SILENCE_THRESHOLD_MS)}.`,
      typical && `Recent ${task?.model ? `${recordedAgentLabel(task.model)} ` : ''}runs took ${typical.phrase} from start to ready (${typical.samples} runs).`,
    ].filter(Boolean).join('\n\n')}</InfoTooltip>}
  </span>;
}

/**
 * Agent, turn counters and the phase timeline: implementation detail that stays behind a
 * disclosure. `collapsible` wraps it in its own one for the Opening; the Application pane
 * already has one.
 */
export function PreparationActivityDetails({ collapsible = false, ...props }: ActivityProps & { collapsible?: boolean }) {
  const { run } = props;
  const busy = preparationBusy(run);
  const now = useTick(busy);
  const { models } = useCodexModelCatalog().catalog;
  const { task } = currentTurn(props);
  const agent = agentLine(task, models);
  const turn = busy ? turnLine(task?.activity, now) : undefined;
  const phases = phaseDurations(run, now);
  if (!agent && !turn && !phases.length) return null;
  const body = <div className="preparation-activity-details">
    {agent && <p>{agent}</p>}
    {turn && <p>{turn}</p>}
    {phases.length > 0 && <ul aria-label="Time in each phase">
      {phases.map(row => <li key={row.phase} className={row.current ? 'is-current' : undefined}><span>{row.label}</span><span>{formatDuration(row.ms)}</span></li>)}
    </ul>}
  </div>;
  return collapsible ? <details className="preparation-activity-disclosure"><summary>Generation details</summary>{body}</details> : body;
}
