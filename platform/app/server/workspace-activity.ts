import { recordedAgentLabel } from "../shared/codex-models.js";
import { activeFormCheckPass } from "./autofill/form-checks.js";
import { rescanProgressLabel } from "../shared/rescan-progress.js";
import { isTaskBusy, type TaskStatus } from "../shared/types.js";
import { preparationBusy } from "../shared/application-preparation.js";
import type { ReloadWorkItem } from "../shared/app-reload.js";
import type { Store } from "./storage.js";
import type { WorkspaceRuntime } from "./task-kinds/workspace-runtime.js";
import { hasActiveGenerations } from "./generation-control.js";
import { greenhousePullHasWork } from "./greenhouse-pull-stop.js";

type TaskActivityRow = {
  status: unknown;
  rendering: unknown;
  saving: unknown;
};

const taskActivityRows = (store: Store) =>
  store.db
    .prepare(
      `SELECT
    json_extract(json, '$.status') AS status,
    json_extract(json, '$.documentResult.status') AS rendering,
    json_extract(json, '$.autofillResult.status') AS saving
    FROM records WHERE kind='task'`,
    )
    .all() as TaskActivityRow[];

const taskActivityBusy = (row: TaskActivityRow) =>
  isTaskBusy(row.status as TaskStatus) ||
  row.rendering === "rendering" ||
  row.saving === "saving";

/** Check task activity without loading persisted transcripts and tool events. */
export const hasActiveTaskWork = (store: Store) =>
  taskActivityRows(store).some(taskActivityBusy);

/** Read only activity columns until a task is active; completed transcripts can be large. */
export function remainingTaskWork(store: Store) {
  const rows = store.db
    .prepare(
      `SELECT id,
    json_extract(json, '$.status') AS status,
    json_extract(json, '$.documentResult.status') AS rendering,
    json_extract(json, '$.autofillResult.status') AS saving
    FROM records WHERE kind='task'`,
    )
    .all();
  const preparations = store
    .list("application_preparation")
    .filter(preparationBusy);
  const ownedTasks = new Set(preparations.flatMap((run) => run.taskIds));
  const items: ReloadWorkItem[] = preparations.map((run) => {
    const opening = store.opening(run.openingId);
    return {
      id: `preparation:${run.id}`,
      label:
        [opening?.company, opening?.title].filter(Boolean).join(" · ") ||
        "Application preparation",
      detail: run.message,
      page: "openings",
      recordId: run.openingId,
    };
  });
  for (const row of rows) {
    if (
      ownedTasks.has(String(row.id)) ||
      !(
        isTaskBusy(row.status as TaskStatus) ||
        row.rendering === "rendering" ||
        row.saving === "saving"
      )
    )
      continue;
    const task = store.taskSummaries(String(row.id))[0];
    if (!task) continue;
    items.push({
      id: `task:${task.id}`,
      label:
        task.title ||
        `${task.model ? recordedAgentLabel(task.model) : "Agent"} task`,
      detail:
        row.rendering === "rendering"
          ? "Rendering PDFs"
          : row.saving === "saving"
            ? "Saving application answers"
            : task.status,
      page: "questions",
      recordId: task.id,
    });
  }
  return items;
}

/** Deletion also supports offline Stores, where managers cannot report queued
 * work. Live requests always include the canonical runtime inventory above. */
export function remainingDeletionWork(
  store: Store,
  ctx?: WorkspaceRuntime,
): ReloadWorkItem[] {
  const items = ctx ? remainingWorkspaceWork(ctx) : remainingTaskWork(store);
  const add = (id: string, label: string) => {
    if (!items.some((item) => item.id === id))
      items.push({ id, label, detail: "Saved work is still active" });
  };
  if (greenhousePullHasWork(store)) add("greenhouse", "Pull from Greenhouse");
  for (const [kind, id, label] of [
    ["career_scan", "careers", "Careers scan"],
    ["opening_validation_run", "validation", "Opening availability"],
  ] as const) {
    if (
      store.db
        .prepare(
          "SELECT 1 FROM records WHERE kind=? AND json_extract(json,'$.status') IN ('running','queued') LIMIT 1",
        )
        .get(kind)
    )
      add(id, label);
  }
  if (
    store.db
      .prepare(
        "SELECT 1 FROM records WHERE kind='application_follow_up' AND json_type(json,'$.sending')='object' AND COALESCE(json_extract(json,'$.sending.uncertain'),0)=0 LIMIT 1",
      )
      .get()
  )
    add("follow-up-send", "Follow-up email");
  return items;
}

export function remainingWorkspaceWork(
  ctx: WorkspaceRuntime,
): ReloadWorkItem[] {
  const items = remainingTaskWork(ctx.store);
  const add = (id: string, label: string, detail: string) =>
    items.push({ id, label, detail });
  const formChecks = activeFormCheckPass(ctx.store);
  if (formChecks)
    add(
      "form-checks",
      "Application form questions",
      `${formChecks.completed}/${formChecks.queued} checked`,
    );
  const pull = ctx.greenhousePull?.state();
  if (ctx.greenhousePull?.hasWork())
    add(
      "greenhouse",
      "Pull from Greenhouse",
      pull && ["running", "cooldown", "finishing"].includes(pull.status)
        ? `${pull.added}/${pull.target} added · ${pull.phase}`
        : "Finishing earlier Greenhouse reviews",
    );
  if (ctx.careers.active)
    add("careers", "Careers scan", "Scanning employer postings");
  if (ctx.openingValidation.active)
    add("validation", "Opening availability", "Checking saved openings");
  if (ctx.gmail.active)
    add("gmail", "Employer replies", "Checking email replies");
  if (ctx.followUpSends.size)
    add("follow-up-send", "Follow-up email", "Sending through Gmail");
  if (ctx.indexing)
    add(
      "indexing",
      "Rescan files",
      ctx.reindexProgress
        ? rescanProgressLabel(ctx.reindexProgress)
        : "Updating the local index",
    );
  if (!items.length && ctx.preparation?.active())
    add("preparation", "Application preparation", "Finishing saved work");
  if (
    !items.length &&
    (hasActiveGenerations(ctx.store) ||
      ctx.taskOperations.size ||
      ctx.openingOperations.size ||
      ctx.launchingTask)
  )
    add(
      "saving",
      "Finishing current work",
      "Waiting for file generation and pending requests",
    );
  if (
    !items.length &&
    ctx.agent.status().threads.some((thread) => thread.activeTurnId)
  )
    add("agent", "Agent turn", "Waiting for the active turn to finish");
  return items;
}
