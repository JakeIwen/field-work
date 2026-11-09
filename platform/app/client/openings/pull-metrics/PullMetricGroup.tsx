import React, { useState } from "react";
import type { Go } from "../../workspace/workspace-actions";
import type { PullMetricGroup as Group, PullMetricsQuery } from "../../../shared/greenhouse-pull-metrics";
import { usePullMetrics } from "./usePullMetrics";
import { PullMetricPosting } from "./PullMetricPosting";

export function PullMetricGroup({ group, query, go }: { group: Group; query: PullMetricsQuery; go: Go }) {
  const [opened, setOpened] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, loading, error, refresh } = usePullMetrics({ ...query, group: group.key, offset }, opened);
  const postings = data?.postings;
  return <details className="pull-metric-group" onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary><span>{group.label}</span><span className="pull-metric-count">{group.count} postings · {group.occurrences} occurrences{group.share !== null ? ` · ${(group.share * 100).toFixed(1)}% of discards` : " · not a fit discard"}</span></summary>
    {loading && <p role="status">Loading postings…</p>}
    {error && <p role="alert" className="error-text">{error} <button type="button" className="text-button" onClick={refresh}>Retry postings</button></p>}
    {postings && <>
      <ul className="pull-metric-postings">{postings.items.map(posting => <PullMetricPosting key={`${offset}:${posting.key}`} posting={posting} query={query} go={go} />)}</ul>
      <div className="pull-metrics-pagination"><span>{offset + 1}–{offset + postings.items.length} of {postings.total} postings</span>
        {offset > 0 && <button type="button" className="text-button" onClick={() => setOffset(0)}>First postings</button>}
        {postings.nextOffset !== null && <button type="button" className="button secondary" onClick={() => setOffset(postings.nextOffset!)}>Next postings</button>}
      </div>
    </>}
  </details>;
}
