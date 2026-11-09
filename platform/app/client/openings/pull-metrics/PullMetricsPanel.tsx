import React, { useState } from "react";
import { type Go } from "../../workspace/workspace-actions";
import { formatDate } from "../../ui/dates";
import InfoTooltip from "../../ui/InfoTooltip";
import { pullMetricSections, type PullMetricsQuery } from "../../../shared/greenhouse-pull-metrics";
import { usePullMetrics, metricsUrl } from "./usePullMetrics";
import { PullMetricsControls } from "./PullMetricsControls";
import { PullMetricGroup } from "./PullMetricGroup";

const initialQuery: PullMetricsQuery = { section: "scan", groupBy: "metric", sort: "count", metric: "", search: "", includeDuplicates: false, offset: 0 };
const countHelp = "Unique Greenhouse postings are identified by board and job ID across saved pulls. Occurrences count saved candidate records, not repeated search cards. Excluded and deferred outcomes count as discards here; pending, added and already-saved postings do not. Percentages use the filtered unique discard total. One posting can have several grounds or appear in several pulls, so group percentages can sum above 100%. These are saved historical outcomes, not the posting's current eligibility. Scan fit labels reflect the recorded first screen, not every rule that might match. Operational deferrals remain separately labeled. Agent categories are keyword-based navigation aids, not new agent judgments; expand to read the exact grounds.";

export function PullMetricsPanel({ go }: { go: Go }) {
  const [query, setQuery] = useState(initialQuery);
  const [revision, setRevision] = useState(0);
  const { data, error, loading, refresh } = usePullMetrics(query);
  const change = (next: Partial<PullMetricsQuery>) => setQuery(current => ({ ...current, ...next, offset: 0 }));
  return <div className="pull-metrics-body">
    <div className="pull-metrics-toolbar">
      <div role="group" aria-label="Pull metric sections" className="pull-metrics-tabs">
        {Object.entries(pullMetricSections).map(([section, label]) => <button type="button" className="button secondary" key={section} aria-pressed={query.section === section} onClick={() => change({ section: section as PullMetricsQuery["section"], metric: "" })}>{label}</button>)}
      </div>
      <button type="button" className="button secondary" disabled={loading} onClick={() => { refresh(); setRevision(value => value + 1); }}>Refresh</button>
    </div>
    <div className="heading-help"><h3>{pullMetricSections[query.section]}</h3><InfoTooltip label="About pull metric counts">{countHelp}</InfoTooltip></div>
    <PullMetricsControls query={query} metrics={data?.metrics ?? []} change={change} />
    {query.section === "agent" && data && <details className="pull-metrics-instructions"><summary>Shared review instructions (current template)</summary><p>{data.reviewInstructions}</p></details>}
    {loading && <p role="status">Loading pull metrics…</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {data && <>
      <p className="small muted">{data.totals.discards} unique discards · {data.totals.occurrences} occurrences{query.section === "scan" ? ` · ${data.totals.duplicates} already saved` : ` · ${data.totals.remembered} remembered occurrences`} · Updated {formatDate(data.generatedAt, true)}</p>
      {!data.groups.items.length && <p>No matching saved outcomes.</p>}
      <div key={`${metricsUrl(query)}:${revision}`} className="pull-metrics-groups">
        {data.groups.items.map(group => <PullMetricGroup key={group.key} group={group} query={query} go={go} />)}
      </div>
      <div className="pull-metrics-pagination">
        <span>{data.groups.total} groups</span>
        {query.offset > 0 && <button className="text-button" onClick={() => setQuery(current => ({ ...current, offset: 0 }))}>First groups</button>}
        {data.groups.nextOffset !== null && <button className="button secondary" onClick={() => setQuery(current => ({ ...current, offset: data.groups.nextOffset! }))}>Next groups</button>}
      </div>
    </>}
  </div>;
}
