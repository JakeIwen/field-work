import React, { useState } from "react";
import { type Go } from "../../workspace/workspace-actions";
import { formatDate } from "../../ui/dates";
import { pullMetricLabel, type PullMetricPosting as Posting, type PullMetricsQuery } from "../../../shared/greenhouse-pull-metrics";
import { usePullMetrics } from "./usePullMetrics";
import { PullMetricEvidence } from "./PullMetricEvidence";

export function PullMetricPosting({ posting, query, go }: { posting: Posting; query: PullMetricsQuery; go: Go }) {
  const [opened, setOpened] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, loading, error, refresh } = usePullMetrics({ ...query, posting: posting.key, offset }, opened);
  const evidence = data?.evidence;
  return <li className="pull-metric-posting">
    <div className="pull-metric-posting-heading"><strong>{posting.company}</strong><span>{posting.title}</span></div>
    {/^https?:\/\//i.test(posting.url) ? <a href={posting.url} target="_blank" rel="noreferrer" className="pull-metric-url">{posting.url}</a> : <span>{posting.url}</span>}
    <p className="small">{posting.metrics.map(pullMetricLabel).join(" · ")}</p>
    <p className="small muted">{posting.decisions.join(" / ")} · {posting.occurrences} occurrences{posting.remembered > 0 && ` · ${posting.remembered} remembered from an earlier review`} · Latest pull {formatDate(posting.pullDate)} · <a href={`/api/greenhouse/pulls/${encodeURIComponent(posting.runId)}/ledger`} target="_blank" rel="noreferrer">{posting.runId}</a></p>
    <details onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
      <summary>{query.section === "agent" ? "Review grounds and instructions" : "Screen reasons and occurrences"}</summary>
      {loading && <p role="status">Loading saved evidence…</p>}
      {error && <p role="alert" className="error-text">{error} <button type="button" className="text-button" onClick={refresh}>Retry evidence</button></p>}
      {evidence && <>
        <p className="small muted">{evidence.total} matching occurrences across pulls</p>
        {evidence.items.map(item => <PullMetricEvidence key={item.candidateId} evidence={item} go={go} />)}
        <div className="pull-metrics-pagination">
          {offset > 0 && <button type="button" className="text-button" onClick={() => setOffset(0)}>First occurrences</button>}
          {evidence.nextOffset !== null && <button type="button" className="button secondary" onClick={() => setOffset(evidence.nextOffset!)}>Next occurrences</button>}
        </div>
      </>}
    </details>
  </li>;
}
