import React, { useState } from "react";
import InfoTooltip from "../../ui/InfoTooltip";
import { pullMetricGroupings, pullMetricSorts, pullMetricKey, pullMetricLabel, type PullMetricsQuery, type PullMetricMatch } from "../../../shared/greenhouse-pull-metrics";

export function PullMetricsControls({ query, metrics, change }: {
  query: PullMetricsQuery; metrics: PullMetricMatch[]; change: (next: Partial<PullMetricsQuery>) => void;
}) {
  const [search, setSearch] = useState(query.search);
  return <div className="pull-metrics-controls">
    <label>Group by<select value={query.groupBy} onChange={event => change({ groupBy: event.target.value as PullMetricsQuery["groupBy"] })}>
      {Object.entries(pullMetricGroupings).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>Sort by<select value={query.sort} onChange={event => change({ sort: event.target.value as PullMetricsQuery["sort"] })}>
      {Object.entries(pullMetricSorts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>Metric<select value={query.metric} onChange={event => change({ metric: event.target.value, ...(event.target.value === pullMetricKey({ metric: "duplicate" }) ? { includeDuplicates: true } : {}) })}>
      <option value="">All metrics</option>
      {query.metric && !metrics.some(metric => pullMetricKey(metric) === query.metric) && <option value={query.metric}>{query.metric}</option>}
      {metrics.map(metric => <option key={pullMetricKey(metric)} value={pullMetricKey(metric)}>{pullMetricLabel(metric)}</option>)}
    </select></label>
    <form className="pull-metrics-search" onSubmit={event => { event.preventDefault(); change({ search }); }}>
      <label>Filter postings<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button type="submit" className="button secondary">Filter</button>
    </form>
    {query.section === "scan" && <span className="heading-help"><label className="pull-metrics-checkbox"><input type="checkbox" checked={query.includeDuplicates} onChange={event => change({ includeDuplicates: event.target.checked })} />Show already saved</label><InfoTooltip label="About already-saved postings">Already-saved postings are duplicates, not fit discards. They stay out of discard totals and percentages even when shown.</InfoTooltip></span>}
  </div>;
}
