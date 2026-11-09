import {
  defaultGreenhousePullPolicy,
  greenhouseCardDateMarginDays,
} from "../shared/greenhouse-policy.js";
import {
  greenhouseActivityLane as lane,
  greenhouseActivityLevel as level,
  greenhouseActivityLaneLimit,
  type GreenhouseActivity,
} from "../shared/greenhouse-pull.js";
import { isTaskWaiting } from "../shared/types.js";
import type { GreenhouseSearchTransport } from "../shared/greenhouse-search.js";
import {
  legacyMultiProviderPull,
  type PullRun,
  type PullCandidate,
} from "./greenhouse-pull-records.js";
import { failedGreenhouseReview } from "./greenhouse-pull-scheduling.js";
import { tunable } from "./tunables.js";
import type { Store } from "./storage.js";
import { greenhouseSearchIdentity } from "../shared/greenhouse-search.js";
import type { GreenhousePage } from "./greenhouse-search.js";
import type { GreenhouseBatchTriage } from "./opening-pull/card-triage.js";

const activityTextLimit = 240;
const activityReasonLimit = 100;
export function greenhouseActivityText(
  value: unknown,
  limit = activityReasonLimit,
) {
  const text = String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function appendGreenhouseActivity(
  run: PullRun,
  entry: Omit<GreenhouseActivity, "at">,
  at: number,
): PullRun {
  return {
    ...run,
    activity: [
      ...(run.activity ?? []),
      {
        ...entry,
        text: greenhouseActivityText(entry.text, activityTextLimit),
        at: new Date(at).toISOString(),
      },
    ],
  };
}

export function greenhouseFailureActivity(
  run: PullRun,
  error: unknown,
  retryAt: string | undefined,
  bridge: boolean,
  at: number,
) {
  const cause = greenhouseActivityText(error);
  const text = retryAt
    ? `${bridge ? "Chrome bridge retry" : "Cooldown started"} until ${retryAt}: ${cause}`
    : `Run failed: ${cause}${bridge ? "; check the configured browser bridge service and its health endpoint" : ""}`;
  return appendGreenhouseActivity(
    run,
    { lane: lane.search, level: retryAt ? level.warn : level.error, text },
    at,
  );
}

export function greenhousePageActivity(
  run: PullRun,
  page: GreenhousePage,
  counts: GreenhouseBatchTriage,
  at: number,
) {
  const { label } = greenhouseSearchIdentity(page);
  let next = appendGreenhouseActivity(
    run,
    {
      lane: lane.search,
      level: level.info,
      text: `${label}, page ${page.page}: ${page.cards.length} results, ${counts.new} new for review`,
    },
    at,
  );
  const labels = {
    title: "skipped by title",
    old: `older than ${(run.policy?.freshnessDays ?? defaultGreenhousePullPolicy.freshnessDays) + (run.policy?.cardDateMarginDays ?? greenhouseCardDateMarginDays)} days by search date`,
    company: "by company filter",
    existing: "already saved",
    seen: "seen earlier",
  } as const;
  const summary = (Object.keys(labels) as (keyof typeof labels)[])
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${labels[key]}`)
    .join(", ");
  next = appendGreenhouseActivity(
    next,
    {
      lane: lane.search,
      level: level.info,
      text: [summary, `${counts.remembered} reviewed in earlier pulls`]
        .filter(Boolean)
        .join(", "),
      triagePage: `${greenhouseSearchIdentity(page).key}:${page.page}`,
    },
    at,
  );
  if (!page.more)
    next = appendGreenhouseActivity(
      next,
      {
        lane: lane.search,
        level: level.info,
        text: `${label}: searched to the end`,
      },
      at,
    );
  return next;
}

// Trim at persistence boundaries: intermediate appends must not discard entries
// before the live retention limit is known.
export function retainGreenhouseActivity(store: Store, run: PullRun): PullRun {
  return {
    ...run,
    activity: run.activity?.slice(-tunable(store, "greenhouse.activityPerRun")),
  };
}

export function greenhouseActivitySnapshot(
  run: PullRun,
  limit: number = greenhouseActivityLaneLimit,
) {
  const activity = run.activity ?? [];
  const selected = new Set(
    Object.values(lane).flatMap((value) =>
      activity.filter((entry) => entry.lane === value).slice(-limit),
    ),
  );
  return activity.filter((entry) => selected.has(entry));
}

export function greenhouseReviewActivity(
  run: PullRun,
  candidate: PullCandidate,
  action: string,
  at: number,
  severity: GreenhouseActivity["level"] = level.info,
  reason?: unknown,
) {
  return appendGreenhouseActivity(
    run,
    {
      lane: lane.review,
      level: severity,
      candidateId: candidate.id,
      taskId: candidate.taskId,
      text: `${action} ${candidate.card.company} · ${candidate.card.title}${reason ? `: ${greenhouseActivityText(reason)}` : ""}`,
    },
    at,
  );
}

const outcomeLabels: Partial<Record<PullCandidate["state"], string>> = {
  added: "Added",
  existing: "Already saved",
  excluded: "Excluded",
  deferred: "Deferred",
};
export function greenhouseOutcomeActivity(
  run: PullRun,
  candidate: PullCandidate,
  state: PullCandidate["state"],
  reason: string,
  at: number,
  targetReached = false,
) {
  const action = outcomeLabels[state];
  const next = action
    ? greenhouseReviewActivity(
        run,
        candidate,
        action,
        at,
        state === "deferred" ? level.warn : level.info,
        state === "excluded" || state === "deferred" ? reason : undefined,
      )
    : run;
  return targetReached
    ? appendGreenhouseActivity(
        next,
        {
          lane: lane.search,
          level: level.info,
          text: `Target reached: ${run.target} openings added`,
        },
        at,
      )
    : next;
}

export function greenhouseSaveActivity(store: Store, run: PullRun, at: number) {
  const next = greenhouseStatusActivity(
    store.get("greenhouse_pull_run", run.id),
    run,
    at,
  );
  return retainGreenhouseActivity(
    store,
    next.searchTransport && next.searchTransportNote
      ? greenhouseTransportActivity(
          next,
          next.searchTransport,
          next.searchTransportNote,
          at,
        )
      : next,
  );
}

export function recordGreenhouseReviewStart(
  store: Store,
  candidate: PullCandidate,
  at: number,
) {
  const run = store.get("greenhouse_pull_run", candidate.runId);
  const saved = store.get("greenhouse_pull_candidate", candidate.id);
  if (!run || !saved || saved.taskId !== candidate.taskId) return false;
  store.put(
    "greenhouse_pull_run",
    run.id,
    retainGreenhouseActivity(
      store,
      greenhouseReviewActivity(run, saved, "Reviewing", at),
    ),
  );
  store.autoExport();
  return true;
}

export function greenhouseInterruptionFailureActivity(
  store: Store,
  run: PullRun,
  taskId: string,
  error: unknown,
  at: number,
) {
  const candidateId = store.get("task", taskId)?.greenhousePull?.candidateId;
  const candidate =
    candidateId && store.get("greenhouse_pull_candidate", candidateId);
  return candidate
    ? greenhouseReviewActivity(
        run,
        candidate,
        "Left running after stop:",
        at,
        level.error,
        `Could not interrupt: ${greenhouseActivityText(error)}`,
      )
    : run;
}

export function greenhouseReviewFailureActivity(
  store: Store,
  run: PullRun,
  error: unknown,
  at: number,
) {
  const candidate =
    run.currentId && store.get("greenhouse_pull_candidate", run.currentId);
  const task =
    candidate && candidate.taskId && store.get("task", candidate.taskId);
  return candidate && task && !failedGreenhouseReview(task.status)
    ? greenhouseReviewActivity(
        run,
        candidate,
        "Review failed for",
        at,
        level.error,
        error,
      )
    : run;
}

export function greenhouseStatusActivity(
  previous: PullRun | undefined,
  run: PullRun,
  at: number,
) {
  if (!previous || previous.status === run.status) return run;
  const messages: Partial<Record<PullRun["status"], string>> = {
    paused: run.phase.startsWith("Service restarted")
      ? "Paused after service restart"
      : "Paused",
    finishing: run.phase,
    stopped: "Stopped searching",
    running:
      previous.retryAt && Date.parse(previous.retryAt) <= at
        ? "Cooldown over; resuming saved progress"
        : "Resumed saved progress",
    cooldown: `Resumed; cooldown until ${run.retryAt}`,
    target_reached: run.finishReason
      ? "Target reached"
      : `Target reached: ${run.target} openings added`,
    exhausted: "Selected searches reached the end",
  };
  const text = messages[run.status];
  return text
    ? appendGreenhouseActivity(
        run,
        { lane: lane.search, level: level.info, text },
        at,
      )
    : run;
}

export function greenhouseTransportActivity(
  run: PullRun,
  searchTransport: GreenhouseSearchTransport,
  searchTransportNote: string | undefined,
  at: number,
) {
  const next = { ...run, searchTransport, searchTransportNote };
  // Discovery resets its transport projection between pages; a fallback is a run event, not a page event.
  if (!searchTransportNote || run.activityTransportNote === searchTransportNote)
    return next;
  return appendGreenhouseActivity(
    { ...next, activityTransportNote: searchTransportNote },
    { lane: lane.search, level: level.warn, text: searchTransportNote },
    at,
  );
}

/** Persist status edges independently of scheduler selection, including waiting and stopped reviews. */
export function observeGreenhouseReviewActivity(store: Store, at: number) {
  return store.transaction(() => {
    const rows = store.db
      .prepare(
        `
    SELECT id, json_remove(json, '$.posting') AS json FROM records
    WHERE kind = 'greenhouse_pull_candidate' AND json_extract(json, '$.state') = 'reviewing'
  `,
      )
      .all() as { id: string; json: string }[];
    const runs = new Map<string, PullRun>();
    for (const row of rows) {
      const candidate = JSON.parse(row.json) as PullCandidate;
      const task = candidate.taskId && store.get("task", candidate.taskId);
      if (!task || task.status === candidate.activityStatus) continue;
      const run =
        runs.get(candidate.runId) ??
        store.get("greenhouse_pull_run", candidate.runId);
      if (!run || legacyMultiProviderPull(run)) continue;
      const action = isTaskWaiting(task.status)
        ? "Needs input for"
        : failedGreenhouseReview(task.status)
          ? `Review ${task.status} for`
          : undefined;
      if (action)
        runs.set(
          run.id,
          greenhouseReviewActivity(
            run,
            candidate,
            action,
            at,
            isTaskWaiting(task.status) ? level.warn : level.error,
            task.error,
          ),
        );
      const saved = store.get("greenhouse_pull_candidate", row.id);
      if (saved)
        store.put("greenhouse_pull_candidate", row.id, {
          ...saved,
          activityStatus: task.status,
        });
    }
    for (const run of runs.values())
      store.put("greenhouse_pull_run", run.id, {
        ...retainGreenhouseActivity(store, run),
        updatedAt: new Date(at).toISOString(),
      });
    if (runs.size) store.autoExport();
    return runs.size > 0;
  });
}
