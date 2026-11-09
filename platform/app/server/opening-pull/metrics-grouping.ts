import {
  pullMetricKey,
  pullMetricLabel,
  type PullMetricPosting,
  type PullMetricsQuery,
} from "../../shared/greenhouse-pull-metrics.js";
import type { MetricOccurrence } from "./metrics-read.js";
import { FIELDWORK_TIMEZONE } from "../../shared/timezone.js";

const pullDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: FIELDWORK_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function occurrenceGroups(
  row: MetricOccurrence,
  groupBy: PullMetricsQuery["groupBy"],
) {
  const groups = {
    metric: () =>
      row.metrics.map((metric) => ({
        key: pullMetricKey(metric),
        label: pullMetricLabel(metric),
      })),
    company: () => [
      { key: row.company.toLocaleLowerCase("en-US"), label: row.company },
    ],
    pull: () => [
      {
        key: row.runId,
        label: `${row.pullDate && Number.isFinite(Date.parse(row.pullDate)) ? pullDateFormat.format(new Date(row.pullDate)) : "Unknown date"} · ${row.runId}`,
      },
    ],
  };
  return groups[groupBy]();
}
export function matchesMetricSearch(row: MetricOccurrence, search: string) {
  return (
    !search ||
    [
      row.company,
      row.title,
      row.url,
      row.reason,
      row.review?.softwareAssessment,
      row.review?.remoteAssessment,
      row.review?.fitAssessment,
      ...row.metrics.map(pullMetricLabel),
    ].some((text) =>
      text
        ?.toLocaleLowerCase("en-US")
        .includes(search.toLocaleLowerCase("en-US")),
    )
  );
}
export function mergeMetricPosting(
  postings: Map<string, PullMetricPosting>,
  row: MetricOccurrence,
) {
  const old = postings.get(row.key);
  const latest = !old || (row.pullDate ?? "") > (old.pullDate ?? "");
  const metrics = new Map(
    [...(old?.metrics ?? []), ...row.metrics].map((match) => [
      pullMetricKey(match),
      match,
    ]),
  );
  postings.set(row.key, {
    key: row.key,
    company: latest ? row.company : old.company,
    title: latest ? row.title : old.title,
    url: latest ? row.url : old.url,
    metrics: [...metrics.values()],
    decisions: [...new Set([...(old?.decisions ?? []), row.state])],
    occurrences: (old?.occurrences ?? 0) + 1,
    remembered: (old?.remembered ?? 0) + Number(Boolean(row.rememberedAt)),
    pullDate: latest ? row.pullDate : old.pullDate,
    runId: latest ? row.runId : old.runId,
  });
}
