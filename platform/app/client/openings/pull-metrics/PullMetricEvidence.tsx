import React from "react";
import AppLink from "../../ui/AppLink";
import { type Go } from "../../workspace/workspace-actions";
import { formatDate } from "../../ui/dates";
import type { PullMetricEvidence as Evidence } from "../../../shared/greenhouse-pull-metrics";

export function PullMetricEvidence({ evidence, go }: { evidence: Evidence; go: Go }) {
  return <article className="pull-metric-evidence">
    <p className="small">{evidence.decision} · Pull {formatDate(evidence.pullDate)} · <a href={`/api/greenhouse/pulls/${encodeURIComponent(evidence.runId)}/ledger`} target="_blank" rel="noreferrer">{evidence.runId}</a></p>
    {evidence.rememberedAt && <p>Remembered from an earlier review · {formatDate(evidence.rememberedAt)}</p>}
    <dl>
      <dt>Reason</dt><dd>{evidence.reason}</dd>
      {evidence.taskId && <>
        <dt>Software assessment</dt><dd>{evidence.softwareAssessment ?? "Saved assessment unavailable."}</dd>
        <dt>Remote assessment</dt><dd>{evidence.remoteAssessment ?? "Saved assessment unavailable."}</dd>
        <dt>Fit assessment</dt><dd>{evidence.fitAssessment ?? "Saved assessment unavailable."}</dd>
      </>}
      <dt>Pull instructions captured for this run</dt><dd>{evidence.instructions ?? "No instructions snapshot saved for this run."}{evidence.instructions === "" && "No additional pull instructions."}</dd>
      {evidence.prompt && <><dt>Review prompt{evidence.promptSource === "current-template" ? " (reconstructed from current template)" : " (captured)"}</dt><dd>{evidence.prompt}</dd></>}
    </dl>
    {evidence.taskId && <AppLink page="agents" id={evidence.taskId} go={go}>Review conversation</AppLink>}
  </article>;
}
