import React from "react";
import InfoTooltip from "../ui/InfoTooltip";
import { recordedAgentLabel } from "../../shared/codex-models";

const reportedCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown) =>
  reportedCount(value) ? value.toLocaleString("en-US") : "Not reported";

/** Codex totals are cumulative; `last` is one model request, not a whole turn. */
export default function TaskUsage({
  task,
  compact = false,
}: {
  task: any;
  compact?: boolean;
}) {
  const provider = recordedAgentLabel(task.model);
  const total = task.usage?.total;
  const available = reportedCount(total?.totalTokens);
  const finished = ["completed", "failed", "interrupted", "idle"].includes(task.status);
  if (!available && !finished) return null;
  if (compact)
    return (
      <small className="task-usage-compact">
        {available ? `${count(total.totalTokens)} tokens · task total` : "Usage not reported"}
      </small>
    );
  return (
    <section className="task-usage" aria-label="Task usage">
      <div className="task-usage-heading">
        <div className="heading-help">
          <strong>{finished ? "Task usage" : "Usage so far"}</strong>
          {available && <InfoTooltip label="About task usage">Cumulative for this task, including follow-ups and revisions.</InfoTooltip>}
        </div>
        <span>{available ? `${count(total.totalTokens)} tokens` : `Not reported by ${provider}`}</span>
      </div>
      {available && (
        <>
          <details>
            <summary>Usage breakdown <InfoTooltip label="About usage reporting">{`Reported by ${provider}. Repeated context counts toward input. Token usage is not a dollar charge or percentage of your subscription allowance.`}</InfoTooltip></summary>
            <dl className="task-usage-breakdown">
              <div><dt>Input tokens</dt><dd>{count(total.inputTokens)}</dd></div>
              <div><dt>Cached input <InfoTooltip label="About cached input">Included in input tokens.</InfoTooltip></dt><dd>{count(total.cachedInputTokens)}</dd></div>
              <div><dt>Output tokens</dt><dd>{count(total.outputTokens)}</dd></div>
              <div><dt>Reasoning tokens <InfoTooltip label="About reasoning tokens">Included in output tokens.</InfoTooltip></dt><dd>{count(total.reasoningOutputTokens)}</dd></div>
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
