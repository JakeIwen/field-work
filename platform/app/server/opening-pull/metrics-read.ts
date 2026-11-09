import type { Store } from "../storage.js";
import type { Task } from "../../shared/task-records.js";
import type { PullCandidate } from "../greenhouse-pull-records.js";
import { pullResearchRequest } from "../greenhouse-research.js";
import type {
  PullMetricDecision,
  PullMetricEvidence,
  PullMetricMatch,
  PullMetricSection,
} from "../../shared/greenhouse-pull-metrics.js";
import {
  classifyPullScreen,
  classifyPullReview,
} from "./metric-classifiers.js";

type Decision = NonNullable<Task["greenhouseDecision"]>;
type ProjectedCandidate = {
  candidateId: string;
  runId: string;
  board: string;
  postingId: string;
  company: string;
  title: string;
  url: string;
  state: PullMetricDecision;
  reason: string | null;
  reviewed: number | null;
  rememberedAt: string | null;
  taskId: string | null;
  pullDate: string | null;
  decisionJson: string | null;
  memoryReason: string | null;
};
export type MetricOccurrence = ProjectedCandidate & {
  key: string;
  section: PullMetricSection;
  metrics: PullMetricMatch[];
  reason: string;
  review?: Decision;
};

/** SQLite parses stored JSON; JS receives no posting bodies, task contexts or run pages. */
export function* metricOccurrences(store: Store): Generator<MetricOccurrence> {
  const rows = store.db
    .prepare(
      `
    SELECT c.id AS candidateId,
      json_extract(c.json,'$.runId') AS runId,
      json_extract(c.json,'$.card.board') AS board,
      CAST(json_extract(c.json,'$.card.id') AS TEXT) AS postingId,
      json_extract(c.json,'$.card.company') AS company,
      json_extract(c.json,'$.card.title') AS title,
      json_extract(c.json,'$.card.url') AS url,
      json_extract(c.json,'$.state') AS state,
      json_extract(c.json,'$.reason') AS reason,
      json_extract(c.json,'$.reviewed') AS reviewed,
      json_extract(c.json,'$.remembered.decidedAt') AS rememberedAt,
      COALESCE(json_extract(c.json,'$.taskId'),json_extract(m.json,'$.taskId')) AS taskId,
      json_extract(r.json,'$.createdAt') AS pullDate,
      json_extract(t.json,'$.greenhouseDecision') AS decisionJson,
      json_extract(m.json,'$.reason') AS memoryReason
    FROM records c
    LEFT JOIN records r ON r.kind='greenhouse_pull_run' AND r.id=json_extract(c.json,'$.runId')
    LEFT JOIN records m ON m.kind='greenhouse_review_memory' AND m.id=json_extract(c.json,'$.remembered.memoryId')
      AND json_extract(m.json,'$.decidedAt')=json_extract(c.json,'$.remembered.decidedAt')
    LEFT JOIN records t ON t.kind='task' AND t.id=COALESCE(json_extract(c.json,'$.taskId'),json_extract(m.json,'$.taskId'))
    WHERE c.kind='greenhouse_pull_candidate'
      AND COALESCE(json_extract(c.json,'$.card.provider'),'greenhouse')='greenhouse'
      AND json_extract(c.json,'$.state') IN ('excluded','deferred','existing')
    ORDER BY c.id
  `,
    )
    .iterate();
  for (const raw of rows) {
    const row = raw as unknown as ProjectedCandidate;
    const decision: Decision | undefined = row.decisionJson
      ? JSON.parse(row.decisionJson)
      : undefined;
    const skipped =
      decision?.decision === row.state && typeof decision.reason === "string";
    const agent =
      row.state !== "existing" &&
      Boolean(
        row.rememberedAt ||
        row.reviewed ||
        (skipped && row.reason === decision?.reason),
      );
    const recordedReason = row.reason ?? row.memoryReason ?? "No saved reason";
    // Later edits to a task or replacement memories must not rewrite old metrics.
    const rememberedReason = recordedReason.replace(
      /^Reviewed .+ \((?:Excluded|Deferred)\): /,
      "",
    );
    const sameDecision =
      skipped &&
      (row.rememberedAt
        ? decision?.reason
            ?.replace(/\s+/g, " ")
            .trim()
            .startsWith(rememberedReason)
        : decision?.reason === row.reason);
    const review = agent && sameDecision ? decision : undefined;
    const reason = review?.reason ?? recordedReason;
    yield {
      ...row,
      decisionJson: null,
      key: `${row.board}:${row.postingId}`,
      section: agent ? "agent" : "scan",
      reason,
      review,
      metrics:
        row.state === "existing"
          ? [{ metric: "duplicate" }]
          : agent
            ? classifyPullReview({ ...review, reason })
            : classifyPullScreen(reason),
    };
  }
}

export function metricEvidence(
  store: Store,
  row: MetricOccurrence,
): PullMetricEvidence {
  const run = store.db
    .prepare(
      "SELECT json_extract(json,'$.guidance.instructions') AS instructions FROM records WHERE kind='greenhouse_pull_run' AND id=?",
    )
    .get(row.runId);
  const task = row.taskId
    ? store.db
        .prepare(
          "SELECT json_extract(json,'$.prompt') AS prompt FROM records WHERE kind='task' AND id=?",
        )
        .get(row.taskId)
    : undefined;
  const capturedPrompt = typeof task?.prompt === "string" ? task.prompt : null;
  const candidate: PullCandidate = {
    id: row.candidateId,
    runId: row.runId,
    state: row.state,
    card: {
      board: row.board,
      id: row.postingId,
      title: row.title,
      company: row.company,
      url: row.url,
      firstPublished: null,
    },
  };
  return {
    candidateId: row.candidateId,
    runId: row.runId,
    pullDate: row.pullDate,
    decision: row.state,
    reason: row.reason,
    metrics: row.metrics,
    taskId: row.taskId ?? undefined,
    rememberedAt: row.rememberedAt ?? undefined,
    softwareAssessment: row.review?.softwareAssessment,
    remoteAssessment: row.review?.remoteAssessment,
    fitAssessment: row.review?.fitAssessment,
    instructions:
      typeof run?.instructions === "string" ? run.instructions : null,
    prompt:
      row.section === "agent"
        ? (capturedPrompt ?? pullResearchRequest(candidate).prompt)
        : null,
    promptSource:
      row.section !== "agent"
        ? "none"
        : capturedPrompt
          ? "captured"
          : "current-template",
  };
}
