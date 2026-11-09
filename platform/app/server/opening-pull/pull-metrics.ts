import { tunable } from "../tunables.js";
import { now, HttpError, type Store } from "../storage.js";
import { greenhousePullPolicy } from "../../shared/greenhouse-policy.js";
import { greenhouseReviewInstructionsFor } from "../greenhouse-research.js";
import {
  pullMetricKey,
  pullMetricLabel,
  pullMetricsPageSize,
  pullMetricsResponseBudget,
  type PullMetricGroup,
  type PullMetricMatch,
  type PullMetricPosting,
  type PullMetricEvidence,
  type PullMetricsPage,
  type PullMetricsQuery,
  type PullMetricsResponse,
} from "../../shared/greenhouse-pull-metrics.js";
import { metricOccurrences, metricEvidence } from "./metrics-read.js";
import {
  occurrenceGroups,
  matchesMetricSearch,
  mergeMetricPosting,
} from "./metrics-grouping.js";

type GroupAccumulator = {
  key: string;
  label: string;
  ids: Set<string>;
  discards: Set<string>;
  occurrences: number;
};
function page<T>(
  items: T[],
  offset: number,
  size: number = pullMetricsPageSize,
): PullMetricsPage<T> {
  const selected: T[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + size)) {
    const added = Buffer.byteLength(JSON.stringify(item));
    if (bytes + added > pullMetricsResponseBudget / 2 && selected.length) break;
    if (added > pullMetricsResponseBudget / 2)
      throw new HttpError(
        413,
        "This saved metrics item is too large; use its search ledger for the complete evidence.",
      );
    selected.push(item);
    bytes += added;
  }
  return {
    items: selected,
    total: items.length,
    nextOffset:
      offset + selected.length < items.length ? offset + selected.length : null,
  };
}

function collectMetrics(store: Store, query: PullMetricsQuery) {
  const groups = new Map<string, GroupAccumulator>();
  const metrics = new Map<string, PullMetricMatch>();
  const postings = new Map<string, PullMetricPosting>();
  const evidence: PullMetricEvidence[] = [];
  const ids = new Set<string>(),
    discards = new Set<string>(),
    duplicates = new Set<string>();
  let occurrences = 0,
    remembered = 0,
    evidenceTotal = 0;
  for (const row of metricOccurrences(store)) {
    if (
      row.section !== query.section ||
      !matchesMetricSearch(row, query.search)
    )
      continue;
    row.metrics.forEach((match) => metrics.set(pullMetricKey(match), match));
    if (
      query.metric &&
      !row.metrics.some((match) => pullMetricKey(match) === query.metric)
    )
      continue;
    if (row.state === "existing") {
      duplicates.add(row.key);
      if (!query.includeDuplicates) continue;
    } else discards.add(row.key);
    ids.add(row.key);
    occurrences++;
    if (row.rememberedAt) remembered++;
    const memberships = occurrenceGroups(row, query.groupBy);
    for (const group of memberships) {
      const value = groups.get(group.key) ?? {
        ...group,
        ids: new Set<string>(),
        discards: new Set<string>(),
        occurrences: 0,
      };
      value.ids.add(row.key);
      value.occurrences++;
      if (row.state !== "existing") value.discards.add(row.key);
      groups.set(group.key, value);
    }
    if (query.group && memberships.some((group) => group.key === query.group))
      mergeMetricPosting(postings, row);
    if (query.posting === row.key) {
      if (
        evidenceTotal >= query.offset &&
        evidence.length < tunable(store, "greenhouse.metricsEvidencePageSize")
      )
        evidence.push(metricEvidence(store, row));
      evidenceTotal++;
    }
  }
  return {
    groups,
    metrics,
    postings,
    evidence,
    evidenceTotal,
    totals: {
      postings: ids.size,
      occurrences,
      discards: discards.size,
      duplicates: duplicates.size,
      remembered,
    },
  };
}

/** An on-demand projection, never a cache or part of /api/state. */
export function pullMetrics(
  store: Store,
  query: PullMetricsQuery,
): PullMetricsResponse {
  const { groups, metrics, postings, evidence, evidenceTotal, totals } =
    collectMetrics(store, query);
  const result: PullMetricsResponse = {
    generatedAt: now(),
    totals,
    metrics: [...metrics.values()].sort((a, b) =>
      pullMetricLabel(a).localeCompare(pullMetricLabel(b)),
    ),
    groups: page(
      projectGroups(groups, totals.discards, query.sort),
      query.group || query.posting ? 0 : query.offset,
      tunable(store, "greenhouse.metricsPageSize"),
    ),
    reviewInstructions: greenhouseReviewInstructionsFor(
      greenhousePullPolicy(store.settings()),
    ),
  };
  if (query.group)
    result.postings = page(
      [...postings.values()].sort(
        (a, b) =>
          (query.sort === "count" ? b.occurrences - a.occurrences : 0) ||
          a.company.localeCompare(b.company) ||
          a.title.localeCompare(b.title) ||
          a.key.localeCompare(b.key),
      ),
      query.offset,
      tunable(store, "greenhouse.metricsPageSize"),
    );
  if (query.posting) {
    const evidencePage = page(
      evidence,
      0,
      tunable(store, "greenhouse.metricsEvidencePageSize"),
    );
    result.evidence = {
      ...evidencePage,
      total: evidenceTotal,
      nextOffset:
        query.offset + evidencePage.items.length < evidenceTotal
          ? query.offset + evidencePage.items.length
          : null,
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > pullMetricsResponseBudget)
    throw new HttpError(
      413,
      "Metrics response is too large. Narrow the text filter and try again.",
    );
  return result;
}

function projectGroups(
  groups: Map<string, GroupAccumulator>,
  discards: number,
  sort: PullMetricsQuery["sort"],
): PullMetricGroup[] {
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      label: group.label,
      count: group.ids.size,
      occurrences: group.occurrences,
      share:
        group.discards.size && discards ? group.discards.size / discards : null,
    }))
    .sort(
      (a, b) =>
        (sort === "count" ? b.count - a.count : 0) ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key),
    );
}
