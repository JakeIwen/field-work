import { preparationBusy, type ApplicationPreparation, type PreparationScope, type PreparationStatus } from "../../shared/application-preparation";
import { preparationDefaultParallelRuns } from "../../shared/preparation-settings";
import type { AppState } from "../../shared/types";
import type { NoticeMessage } from "../workspace/workspace-actions";

type PreparationEvent = "started" | "finished" | "stopped";
type PreparationTransition = { run: ApplicationPreparation; event: PreparationEvent };
const scopeLabels: Record<PreparationScope, string> = { full: "Generate Docs", answers: "Answers-only" };
const scopeOrder: PreparationScope[] = ["full", "answers"];
type Snapshot = Pick<AppState, "preparations" | "openings" | "settings">;
const eventOrder: PreparationEvent[] = ["started", "finished", "stopped"];
const running = (status?: PreparationStatus) => status === "running" || status === "waiting";
const shortReasonLimit = 140;
const openingLinkLimit = 3;

function preparationEvent(previous: ApplicationPreparation | undefined, next: ApplicationPreparation): PreparationEvent | undefined {
  if (next.status === previous?.status) return;
  if (next.status === "ready") return "finished";
  if ((next.status === "failed" || next.status === "paused") && preparationBusy(previous)) return "stopped";
  if (running(next.status) && !running(previous?.status) && previous?.status !== "ready") return "started";
}

function stoppedReason(run: ApplicationPreparation) {
  return [run.error, run.message].map(value => value?.replace(/\s+/g, " ").trim())
    .find(value => value && value.length <= shortReasonLimit);
}

function transitionSummary(transitions: PreparationTransition[]) {
  return scopeOrder.flatMap(scope => {
    const scoped = transitions.filter(({ run }) => (run.scope ?? "full") === scope);
    if (!scoped.length) return [];
    const summary = eventOrder.map(event => {
      const count = scoped.filter(transition => transition.event === event).length;
      return count ? `${count} ${event}` : "";
    }).filter(Boolean).join(", ");
    return [`${scopeLabels[scope]}: ${summary}`];
  }).join(" · ");
}

/** A missing previous snapshot is the page-load baseline, not newly started work. */
export function preparationNotice(previous: ApplicationPreparation[] | null, state: Snapshot): NoticeMessage | null {
  if (previous === null) return null;
  const runs = state.preparations ?? [];
  const previousById = new Map(previous.map(run => [run.id, run]));
  const transitions = runs.flatMap(run => {
    const event = preparationEvent(previousById.get(run.id), run);
    return event ? [{ run, event }] : [];
  });
  if (!transitions.length) return null;
  const openingsById = new Map(state.openings.map(opening => [opening.id, opening]));
  const active = runs.filter(run => running(run.status)).length;
  const queued = runs.filter(run => run.status === "queued").length;
  const limit = state.settings.parallelPreparations ?? preparationDefaultParallelRuns;
  const counts = `${active}${limit ? ` of ${limit}` : ""} running${queued ? `, ${queued} queued` : ""}`;
  const single = transitions.length === 1;
  const mixedScopes = new Set(transitions.map(({ run }) => run.scope ?? "full")).size > 1;
  const links = transitions.slice(0, openingLinkLimit).map(({ run, event }) => {
    const opening = openingsById.get(run.openingId);
    const reason = event === "stopped" ? stoppedReason(run) : undefined;
    return {
      label: opening ? `${opening.company} — ${opening.title}` : run.id,
      page: "openings",
      id: run.openingId,
      detail: single ? reason : `${mixedScopes ? scopeLabels[run.scope ?? "full"] + " " : ""}${event}${reason ? `: ${reason}` : ""}`,
    };
  });
  return {
    text: single ? `${scopeLabels[transitions[0].run.scope ?? "full"]} ${transitions[0].event}: ` : `${transitionSummary(transitions)} · ${counts}`,
    links,
    suffix: single ? ` · ${counts}` : undefined,
    more: transitions.length > openingLinkLimit ? transitions.length - openingLinkLimit : undefined,
    tone: transitions.some(({ event }) => event === "stopped") ? "attention" : "success",
  };
}
