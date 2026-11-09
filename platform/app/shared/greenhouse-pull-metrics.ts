import { tunables } from "./tunables-registry.js";
export const pullMetricSections = {
  scan: "Scan fit",
  agent: "Agent review",
} as const;
export type PullMetricSection = keyof typeof pullMetricSections;
export const pullMetricGroupings = {
  metric: "Metric",
  company: "Company",
  pull: "Pull",
} as const;
export type PullMetricGrouping = keyof typeof pullMetricGroupings;
export const pullMetricSorts = { count: "Count", name: "Name" } as const;
export type PullMetricSort = keyof typeof pullMetricSorts;

/** The vocabulary is shared; title terms are separate instances of titleTerm. */
export const pullMetricDefinitions = {
  company: { section: "scan", label: "Company filter" },
  titleTerm: { section: "scan", label: "Excluded title term" },
  titleRole: { section: "scan", label: "Not a software title" },
  searchDate: { section: "scan", label: "Outside the search-date window" },
  publicationDate: {
    section: "scan",
    label: "Outside the publication window",
  },
  missingDate: {
    section: "scan",
    label: "No usable original publication date",
  },
  technology: { section: "scan", label: "Saved technology exclusion" },
  travelPercent: { section: "scan", label: "Excess travel percentage" },
  unavailable: { section: "scan", label: "Posting unavailable or unlisted" },
  workflow: { section: "scan", label: "Review could not publish" },
  duplicate: { section: "scan", label: "Already saved in Fieldwork" },
  otherScreen: { section: "scan", label: "Other screen" },
  location: {
    section: "agent",
    label: "US eligibility / location restriction",
  },
  onsite: { section: "agent", label: "Onsite / hybrid" },
  travel: { section: "agent", label: "Travel requirement" },
  duties: { section: "agent", label: "Not software work" },
  seniority: { section: "agent", label: "Seniority / leadership scope" },
  expertise: { section: "agent", label: "Required technology / domain gap" },
  clearance: { section: "agent", label: "Clearance / citizenship" },
  compensation: { section: "agent", label: "Compensation" },
  employmentType: { section: "agent", label: "Employment type out of scope" },
  engagement: { section: "agent", label: "Engagement type / duration" },
  closed: { section: "agent", label: "Posting closed / unavailable" },
  otherReview: { section: "agent", label: "Other review grounds" },
} as const satisfies Record<
  string,
  { section: PullMetricSection; label: string }
>;
export type PullMetric = keyof typeof pullMetricDefinitions;
export type PullMetricMatch = { metric: PullMetric; detail?: string };
export const pullMetricKey = ({ metric, detail }: PullMetricMatch) =>
  detail ? `${metric}:${detail.toLocaleLowerCase("en-US")}` : metric;
export const pullMetricLabel = ({ metric, detail }: PullMetricMatch) =>
  `${pullMetricDefinitions[metric].label}${detail ? `: ${detail}` : ""}`;
export type PullMetricDecision = "excluded" | "deferred" | "existing";

export type PullMetricsQuery = {
  section: PullMetricSection;
  groupBy: PullMetricGrouping;
  sort: PullMetricSort;
  metric: string;
  search: string;
  includeDuplicates: boolean;
  offset: number;
  group?: string;
  posting?: string;
};
export type PullMetricGroup = {
  key: string;
  label: string;
  count: number;
  occurrences: number;
  share: number | null;
};
export type PullMetricPosting = {
  key: string;
  company: string;
  title: string;
  url: string;
  metrics: PullMetricMatch[];
  decisions: PullMetricDecision[];
  occurrences: number;
  remembered: number;
  pullDate: string | null;
  runId: string;
};
export type PullMetricEvidence = {
  candidateId: string;
  runId: string;
  pullDate: string | null;
  decision: PullMetricDecision;
  reason: string;
  metrics: PullMetricMatch[];
  taskId?: string;
  rememberedAt?: string;
  softwareAssessment?: string;
  remoteAssessment?: string;
  fitAssessment?: string;
  instructions: string | null;
  prompt: string | null;
  promptSource: "captured" | "current-template" | "none";
};
export type PullMetricsPage<T> = {
  items: T[];
  total: number;
  nextOffset: number | null;
};
export type PullMetricsResponse = {
  generatedAt: string;
  totals: {
    postings: number;
    occurrences: number;
    discards: number;
    duplicates: number;
    remembered: number;
  };
  metrics: PullMetricMatch[];
  groups: PullMetricsPage<PullMetricGroup>;
  postings?: PullMetricsPage<PullMetricPosting>;
  evidence?: PullMetricsPage<PullMetricEvidence>;
  reviewInstructions: string;
};
export const pullMetricsPageSize =
  tunables["greenhouse.metricsPageSize"].default;
export const pullMetricsEvidencePageSize =
  tunables["greenhouse.metricsEvidencePageSize"].default;
export const pullMetricsResponseBudget = 240_000;
export const pullMetricsPath = "/api/greenhouse/metrics";
