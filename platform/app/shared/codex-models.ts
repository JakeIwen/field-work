import type { Task, TaskPreset } from "./task-records.js";

export const DEFAULT_EFFORT = "high";
export const modelRequestLabels = {
  questions: "Questions and follow-ups",
  "posting-application": "Tailored resume + cover letter",
  "posting-resume": "Tailored resume",
  "posting-cover-letter": "Tailored cover letter",
  "application-answers": "Application form answers",
  "follow-up-email": "Follow-up emails",
  "opening-research": "Research a posting URL",
  "greenhouse-pull": "Greenhouse search research",
  "resume-revision": "Resume revision",
  "cover-letter": "General cover letter",
  "job-fit": "Job fit assessment",
  "company-research": "Company research",
  "careers-refresh": "Careers research",
} satisfies Record<
  TaskPreset | "application-answers" | "greenhouse-pull",
  string
>;

export type ModelRequestType = keyof typeof modelRequestLabels;
export type ModelPreferences = Partial<Record<ModelRequestType, string>>;
export type EffortPreferences = ModelPreferences;
export const modelRequestTypes = Object.keys(
  modelRequestLabels,
) as ModelRequestType[];
export function isModelRequestType(value: string): value is ModelRequestType {
  return Object.hasOwn(modelRequestLabels, value);
}
/** Settings display order; every request type belongs to exactly one group. */
export const modelRequestGroups: {
  label: string;
  requests: ModelRequestType[];
}[] = [
  {
    label: "Documents",
    requests: [
      "posting-application",
      "posting-resume",
      "posting-cover-letter",
      "cover-letter",
      "resume-revision",
    ],
  },
  {
    label: "Questions and answers",
    requests: ["questions", "application-answers", "follow-up-email"],
  },
  {
    label: "Research",
    requests: [
      "opening-research",
      "greenhouse-pull",
      "job-fit",
      "company-research",
      "careers-refresh",
    ],
  },
];
export function taskModelRequestType(
  task: Pick<Task, "preset" | "autofillContext" | "greenhousePull">,
): ModelRequestType {
  if (task.autofillContext) return "application-answers";
  if (task.greenhousePull) return "greenhouse-pull";
  return task.preset;
}

/** Agent runtimes that can run a request; a model's provider decides which one starts its threads. */
export const agentProviders = ["codex", "claude"] as const;
export type AgentProvider = (typeof agentProviders)[number];
export const agentProviderLabels: Record<AgentProvider, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  /** Absent on Codex app-server models; set for every other provider. */
  provider?: AgentProvider;
  hidden?: boolean;
  supportedReasoningEfforts: {
    reasoningEffort: string;
    description?: string;
  }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};
export const modelProvider = (model: Pick<CodexModel, "provider">) =>
  model.provider ?? "codex";
/** Recorded Claude model IDs retain their provider even when absent from today's catalog. */
export const recordedAgentLabel = (model: string | undefined) =>
  agentProviderLabels[model?.startsWith("claude-") ? "claude" : "codex"];
export type ModelCatalogStatus = {
  models: CodexModel[];
  refreshedAt: string | null;
  refreshing: boolean;
  /** The Codex catalog error; it also governs the unset (recommended default) choice. */
  error: string | null;
  /** Why another provider's models are missing or unusable, keyed by provider. */
  providerErrors?: Partial<Record<AgentProvider, string>>;
};
/** Fieldwork offers only the higher reasoning levels, regardless of provider. */
const withdrawnReasoningEfforts = new Set(["low", "medium"]);
export const offeredReasoningEfforts = <T extends { reasoningEffort: string }>(
  efforts: T[],
) =>
  efforts.filter(
    (entry) => !withdrawnReasoningEfforts.has(entry.reasoningEffort),
  );
export const supportsReasoningEffort = (
  model: CodexModel,
  effort = DEFAULT_EFFORT,
) =>
  model.supportedReasoningEfforts.some(
    (entry) => entry.reasoningEffort === effort,
  );
export const configuredEffort = (
  preferences: EffortPreferences | undefined,
  request: ModelRequestType,
) => preferences?.[request] || DEFAULT_EFFORT;

/** Model id tokens that are not numbers name the family; the numbers, in order, are its version. */
const modelFamily = (model: Pick<CodexModel, "model">) => {
  const tokens = model.model
    .toLowerCase()
    .split(/[-.\s]+/)
    .filter(Boolean);
  return {
    family: tokens.filter((token) => !/^\d+$/.test(token)).join("-"),
    version: tokens.filter((token) => /^\d+$/.test(token)).map(Number),
  };
};
const compareVersions = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};
/**
 * Marks a model hidden when a visible model of the same family has a strictly higher
 * version (gpt-6-sol yields to gpt-6.1-sol). Hidden, not removed, so a saved choice still resolves.
 */
export function hideSupersededModels(models: CodexModel[]): CodexModel[] {
  const identities = models.map((model) => ({ model, ...modelFamily(model) }));
  return identities.map(({ model, family, version }) =>
    !model.hidden &&
    identities.some(
      (other) =>
        !other.model.hidden &&
        other.family === family &&
        compareVersions(other.version, version) > 0,
    )
      ? { ...model, hidden: true }
      : model,
  );
}
/** The models a picker offers: the catalog's visible entries, with superseded versions hidden even when an older backend sent them. */
export const visibleModels = (models: CodexModel[]) =>
  hideSupersededModels(models).filter((model) => !model.hidden);
