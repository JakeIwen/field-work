import type { Store } from "../../server/storage.js";
import type {
  PullCandidate,
  PullRun,
} from "../../server/greenhouse-pull-records.js";
import { card, posting, at } from "./greenhouse-pull-fixture.js";
import { legacyTask } from "./legacy-records.js";
import { validatePullSkip } from "../../server/opening-pull/research.js";

export function metricRun(
  id: string,
  overrides: Partial<PullRun> = {},
): PullRun {
  return {
    id,
    target: 10,
    clientRequestId: id,
    status: "stopped",
    phase: "Stopped",
    queryIndex: 0,
    page: 1,
    cutoff: "2026-09-21T20:00:00Z",
    limitCount: 0,
    pages: [],
    failures: [],
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
    guidance: {
      instructions: "Prefer part-time engineering, but assess actual hours.",
      searchTerms: [],
      employmentTypes: ["part_time"],
    },
    ...overrides,
  };
}
export function metricCandidate(
  runId: string,
  id: string,
  overrides: Partial<PullCandidate> = {},
): PullCandidate {
  return {
    id: `${runId}:example:${id}`,
    runId,
    card: card(id),
    state: "excluded",
    reason: "Older than 8 days by search date",
    ...overrides,
  };
}
export function saveMetricReview(
  store: Store,
  runId: string,
  id: string,
  decision: "excluded" | "deferred" = "excluded",
) {
  const candidate = metricCandidate(runId, id, {
    state: decision,
    reviewed: true,
    taskId: `review-${id}`,
    posting: posting(card(id)),
  });
  const skip = validatePullSkip(
    {
      decision,
      reason:
        "Remote within Canada only; US-based applicants are not eligible.",
      softwareAssessment:
        "Builds production software, a plausible engineering match.",
      remoteAssessment:
        "The role is restricted to Canada; US employment is excluded.",
      fitAssessment:
        "The supplied experience supports the software requirements.",
      sources: [candidate.posting!.apiUrl],
    },
    candidate,
  );
  candidate.reason = skip.reason;
  store.put("greenhouse_pull_candidate", candidate.id, candidate);
  store.put(
    "task",
    candidate.taskId!,
    legacyTask({
      id: candidate.taskId!,
      preset: "opening-research",
      status: "completed",
      prompt: `Captured initial review prompt for ${id}.`,
      greenhousePull: { runId, candidateId: candidate.id },
      greenhouseDecision: skip,
    }),
  );
  return candidate;
}
