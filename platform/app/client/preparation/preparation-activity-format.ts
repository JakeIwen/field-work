import type { CodexModel } from "../../shared/codex-models";
import { recordedAgentLabel } from "../../shared/codex-models";
import type { ApplicationPreparation, PreparationPhase } from "../../shared/application-preparation";
import type { LiveTurnActivity, TaskActivity } from "../../shared/task-activity";
import { isTaskTurnActive, type TaskSummary } from "../../shared/types";

/** The fields of a task these helpers read; a TaskSummary satisfies it. */
type TaskView = Pick<TaskSummary, "id" | "status" | "model" | "effort"> & { activity?: TaskActivity };
type RunView = Pick<ApplicationPreparation, "phase" | "status" | "createdAt" | "updatedAt" | "phaseHistory" | "documentTaskId" | "answerTaskId"> & { scope?: string };

const SECOND = 1000, MINUTE = 60 * SECOND;
/** Past this much silence a long think starts to look like a hang, so the line says so. */
export const SILENCE_THRESHOLD_MS = 2 * MINUTE;
/** The first typical-duration estimate needs this many comparable finished runs. */
export const TYPICAL_MIN_SAMPLES = 3;

const phaseLabels: Partial<Record<PreparationPhase, string>> = {
  queued: "Queued", form: "Form", documents: "Documents", answers: "Answers", packaging: "Packaging",
};
const timelinePhases = Object.keys(phaseLabels) as PreparationPhase[];

/** Seconds under a minute, else whole minutes. */
export function formatDuration(ms: number) {
  const value = Math.max(0, ms);
  return value < MINUTE ? `${Math.floor(value / SECOND)} s` : `${Math.floor(value / MINUTE)} min`;
}

const age = (at: string | undefined, now: number) => {
  const time = at ? Date.parse(at) : NaN;
  return Number.isNaN(time) ? undefined : Math.max(0, now - time);
};

/** Words in a draft written as tool input or text; about six characters each, rounded so it does not flicker. */
const approximateWords = (chars: number) => {
  const words = chars / 6;
  return words >= 100 ? Math.round(words / 10) * 10 : Math.round(words);
};

/**
 * One phrase for what the active turn is doing, or undefined when there is nothing worth saying.
 * Silence outranks the state: a turn with no signal for two minutes is reported as quiet even when
 * its last state was "thinking", because the reader cannot tell a long think from a stall otherwise.
 */
export function livenessPhrase(live: LiveTurnActivity | null | undefined, task: Pick<TaskView, "status" | "activity"> | undefined, now: number) {
  if (task && !isTaskTurnActive(task.status)) return undefined;
  const silent = age(live?.lastSignalAt ?? task?.activity?.lastEventAt, now);
  if (silent !== undefined && silent > SILENCE_THRESHOLD_MS) return `no signal for ${formatDuration(silent)}`;
  if (!live) return undefined;
  switch (live.state) {
    case "thinking": return `thinking for ${formatDuration(age(live.since, now) ?? 0)}`;
    case "writing":
    case "tool": return live.outputChars > 0 ? `writing, about ${approximateWords(live.outputChars)} words` : "writing";
    case "retrying": return live.retry ? `retrying the request (attempt ${live.retry.attempt})` : "retrying the request";
    case "compacting": return "compacting context";
    case "requesting": return "waiting for the model";
  }
}

/** Time spent in the run's current phase, from the newest history entry for it. */
export function elapsedInPhase(run: Pick<RunView, "phase" | "phaseHistory">, now: number) {
  const history = run.phaseHistory ?? [];
  const entry = [...history].reverse().find(item => item.phase === run.phase) ?? history.at(-1);
  return age(entry?.at, now);
}

export type PhaseDuration = { phase: PreparationPhase; label: string; ms: number; current: boolean };

/**
 * Rows for the phase timeline, in pipeline order. A phase entered twice (a restart) sums its
 * stretches; the open stretch ticks while the run is busy and stops at the last update otherwise.
 */
export function phaseDurations(run: Pick<RunView, "phase" | "status" | "updatedAt" | "phaseHistory">, now: number): PhaseDuration[] {
  const history = run.phaseHistory ?? [];
  const busy = ["queued", "running", "waiting"].includes(run.status);
  const totals = new Map<PreparationPhase, number>();
  history.forEach((entry, index) => {
    if (!phaseLabels[entry.phase]) return;
    const start = Date.parse(entry.at);
    const next = history[index + 1];
    const end = next ? Date.parse(next.at) : busy ? now : Date.parse(run.updatedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    totals.set(entry.phase, (totals.get(entry.phase) ?? 0) + Math.max(0, end - start));
  });
  const last = history.at(-1)?.phase;
  return timelinePhases.flatMap(phase => {
    const ms = totals.get(phase);
    return ms === undefined || ms < SECOND ? [] : [{ phase, label: phaseLabels[phase]!, ms, current: busy && phase === last }];
  });
}

function percentile(sorted: number[], fraction: number) {
  const position = (sorted.length - 1) * fraction, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export type TypicalDuration = { samples: number; medianMs: number; lowMs: number; highMs: number; phrase: string };

/**
 * How long comparable finished runs took: first non-queued phase to ready, over full-scope ready
 * runs that generated documents (answers-only and PDF-reuse runs are not comparable). When a
 * provider label is given, only runs whose document task is known and used that provider count,
 * since Codex and Claude turns differ several-fold. Returns undefined under three samples.
 */
export function typicalDuration(runs: readonly RunView[], tasks: readonly Pick<TaskView, "id" | "model">[], label?: string): TypicalDuration | undefined {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const durations: number[] = [];
  for (const run of runs) {
    if (run.status !== "ready" || run.scope === "answers" || !run.documentTaskId) continue;
    if (label !== undefined) {
      const task = byId.get(run.documentTaskId);
      if (!task || recordedAgentLabel(task.model) !== label) continue;
    }
    const history = run.phaseHistory ?? [];
    const started = history.find(entry => entry.phase !== "queued"), finished = history.find(entry => entry.phase === "ready");
    if (!started || !finished) continue;
    const ms = Date.parse(finished.at) - Date.parse(started.at);
    if (Number.isFinite(ms) && ms > 0) durations.push(ms);
  }
  if (durations.length < TYPICAL_MIN_SAMPLES) return undefined;
  durations.sort((a, b) => a - b);
  const lowMs = percentile(durations, 0.25), highMs = percentile(durations, 0.75), medianMs = percentile(durations, 0.5);
  const low = Math.max(1, Math.round(lowMs / MINUTE)), high = Math.max(1, Math.round(highMs / MINUTE));
  return { samples: durations.length, medianMs, lowMs, highMs, phrase: low === high ? `about ${low} min` : `about ${low}–${high} min` };
}

/** "Claude Code · Fable 5.1 · xhigh": provider, catalog display name (the id when the catalog lacks it) and effort. */
export function agentLine(task: Pick<TaskView, "model" | "effort"> | undefined, models: readonly Pick<CodexModel, "id" | "model" | "displayName">[] = []) {
  if (!task?.model) return undefined;
  const entry = models.find(model => model.id === task.model || model.model === task.model);
  return [recordedAgentLabel(task.model), entry?.displayName || task.model, task.effort].filter(Boolean).join(" · ");
}

/** "Turn 2 · 14 tool calls · last event 9 min ago: read dossier". */
export function turnLine(activity: TaskActivity | undefined, now: number) {
  if (!activity) return undefined;
  const parts = [`Turn ${activity.turn}`, `${activity.toolCalls} tool ${activity.toolCalls === 1 ? "call" : "calls"}`];
  const since = age(activity.lastEventAt, now);
  if (since !== undefined) parts.push(`last event ${formatDuration(since)} ago${activity.lastEvent ? `: ${activity.lastEvent}` : ""}`);
  return parts.join(" · ");
}

/**
 * The task whose turn the run is waiting on: the one for its current phase, else any with an
 * active turn, else the first it has. Tasks come from the state snapshot, which refetches on
 * every adapter event.
 */
export function preparationTask<T extends Pick<TaskView, "id" | "status">>(run: Pick<RunView, "phase" | "documentTaskId" | "answerTaskId"> | undefined, tasks: readonly T[]) {
  if (!run) return undefined;
  const find = (id?: string) => (id ? tasks.find(task => task.id === id) : undefined);
  const documents = find(run.documentTaskId), answers = find(run.answerTaskId);
  const byPhase = run.phase === "answers" ? answers : run.phase === "documents" ? documents : undefined;
  return byPhase ?? [documents, answers].find(task => task && isTaskTurnActive(task.status)) ?? documents ?? answers;
}
