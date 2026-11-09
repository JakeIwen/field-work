import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationPreparation } from "../../shared/application-preparation";
import type { LiveTurnActivity } from "../../shared/task-activity";
import { agentLine, elapsedInPhase, formatDuration, livenessPhrase, phaseDurations, preparationTask, turnLine, typicalDuration } from "./preparation-activity-format";

const T0 = Date.parse("2026-11-06T12:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const running = { status: "running" as const };
const live = (patch: Partial<LiveTurnActivity>): LiveTurnActivity => ({ state: "thinking", since: at(0), lastSignalAt: at(0), outputChars: 0, ...patch });

test("durations show seconds under a minute and whole minutes after", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(59_999), "59 s");
  assert.equal(formatDuration(60_000), "1 min");
  assert.equal(formatDuration(12.9 * 60_000), "12 min");
});

test("liveness phrases follow the live state and report silence over two minutes", () => {
  assert.equal(livenessPhrase(live({}), running, T0 + 3 * 60_000), "no signal for 3 min");
  assert.equal(livenessPhrase(live({ lastSignalAt: at(235) }), running, T0 + 240_000), "thinking for 4 min");
  assert.equal(livenessPhrase(live({ state: "writing", outputChars: 4800, lastSignalAt: at(10) }), running, T0 + 10_000), "writing, about 800 words");
  assert.equal(livenessPhrase(live({ state: "tool", outputChars: 120, lastSignalAt: at(10) }), running, T0 + 10_000), "writing, about 20 words");
  assert.equal(livenessPhrase(live({ state: "retrying", retry: { attempt: 2, delayMs: 4000 }, lastSignalAt: at(10) }), running, T0 + 10_000), "retrying the request (attempt 2)");
  assert.equal(livenessPhrase(live({ state: "compacting", lastSignalAt: at(10) }), running, T0 + 10_000), "compacting context");
  assert.equal(livenessPhrase(live({ state: "requesting", lastSignalAt: at(10) }), running, T0 + 10_000), "waiting for the model");
  assert.equal(livenessPhrase(live({ lastSignalAt: at(0) }), running, T0 + 9 * 60_000), "no signal for 9 min");
});

test("without live data the task's last event dates the silence, and finished tasks say nothing", () => {
  const activity = { turn: 1, toolCalls: 0, lastEventAt: at(0) };
  assert.equal(livenessPhrase(null, { ...running, activity }, T0 + 9 * 60_000), "no signal for 9 min");
  assert.equal(livenessPhrase(null, { ...running, activity }, T0 + 60_000), undefined);
  assert.equal(livenessPhrase(null, undefined, T0 + 9 * 60_000), undefined);
  assert.equal(livenessPhrase(live({ lastSignalAt: at(0) }), { status: "completed", activity }, T0 + 9 * 60_000), undefined);
});

const base = { phase: "documents" as const, status: "running" as const, createdAt: at(0), updatedAt: at(900) };

test("phase durations sum repeated phases, skip zero-length ones and tick the current phase", () => {
  const run = { ...base, phaseHistory: [
    { phase: "queued" as const, at: at(0) }, { phase: "form" as const, at: at(0) }, { phase: "documents" as const, at: at(30) },
    { phase: "documents" as const, at: at(300) }, { phase: "form" as const, at: at(400) }, { phase: "documents" as const, at: at(430) },
  ] };
  const rows = phaseDurations(run, T0 + 730_000);
  assert.deepEqual(rows.map(row => [row.phase, Math.round(row.ms / 1000), row.current]), [["form", 30 + 30, false], ["documents", 270 + 100 + 300, true]]);
  assert.deepEqual(phaseDurations({ ...base, status: "failed", phaseHistory: run.phaseHistory }, T0 + 99_999_000).at(-1)?.ms, (270 + 100 + 470) * 1000);
  assert.deepEqual(phaseDurations(base, T0), []);
  assert.equal(elapsedInPhase(run, T0 + 730_000), 300_000);
  assert.equal(elapsedInPhase(base, T0), undefined);
});

const ready = (index: number, seconds: number, extra: Record<string, unknown> = {}) => ({
  id: `run-${index}`, openingId: `o${index}`, applicationId: `a${index}`, status: "ready" as const, phase: "ready" as const, message: "", openingHash: "h",
  documentIds: [], taskIds: [], supportedForm: true, createdAt: at(0), updatedAt: at(seconds), documentTaskId: `t${index}`,
  phaseHistory: [{ phase: "queued" as const, at: at(0) }, { phase: "form" as const, at: at(20) }, { phase: "ready" as const, at: at(20 + seconds) }], ...extra,
}) as ApplicationPreparation;

test("typical duration needs three comparable full runs and groups by provider", () => {
  const runs = [ready(1, 540), ready(2, 600), ready(3, 720), ready(4, 900), ready(5, 60, { scope: "answers" }), ready(6, 60, { documentTaskId: undefined })];
  const tasks = [1, 2, 3].map(i => ({ id: `t${i}`, model: "gpt-6-astra" })).concat([{ id: "t4", model: "claude-fable-5-1" }]);
  assert.equal(typicalDuration(runs.slice(0, 2), tasks), undefined);
  const all = typicalDuration(runs, tasks)!;
  assert.equal(all.samples, 4);
  assert.equal(typicalDuration(runs, tasks, "Codex")?.phrase, "about 10–11 min");
  assert.equal(typicalDuration(runs, tasks, "Claude Code"), undefined);
  assert.equal(all.phrase, "about 10–13 min");
});

test("agent and turn lines use the catalog name when it has one", () => {
  const models = [{ id: "claude-fable-5-1", model: "claude-fable-5-1", displayName: "Fable 5.1" }];
  assert.equal(agentLine({ model: "claude-fable-5-1", effort: "xhigh" }, models), "Claude Code · Fable 5.1 · xhigh");
  assert.equal(agentLine({ model: "gpt-6-astra", effort: "high" }), "Codex · gpt-6-astra · high");
  assert.equal(agentLine({ model: undefined }), undefined);
  assert.equal(turnLine({ turn: 2, toolCalls: 14, lastEventAt: at(0), lastEvent: "read dossier" }, T0 + 9 * 60_000), "Turn 2 · 14 tool calls · last event 9 min ago: read dossier");
  assert.equal(turnLine({ turn: 1, toolCalls: 1, lastEventAt: at(0) }, T0 + 5000), "Turn 1 · 1 tool call · last event 5 s ago");
  assert.equal(turnLine(undefined, T0), undefined);
});

test("the run's task follows its phase, then any active turn", () => {
  const tasks = [{ id: "d", status: "completed" as const }, { id: "a", status: "running" as const }];
  const run = { phase: "documents" as const, documentTaskId: "d", answerTaskId: "a" };
  assert.equal(preparationTask(run, tasks)?.id, "d");
  assert.equal(preparationTask({ ...run, phase: "form" }, tasks)?.id, "a");
  assert.equal(preparationTask(undefined, tasks), undefined);
});
