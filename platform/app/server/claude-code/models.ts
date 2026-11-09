import { tunables, type TunableKey } from "../../shared/tunables.js";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_EFFORT,
  offeredReasoningEfforts,
  supportsReasoningEffort,
  type CodexModel,
} from "../../shared/codex-models.js";

/** The Claude Code models offered by this deployment. */
export const claudeModelChoices = [
  { model: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { model: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
] as const;

export const isClaudeModel = (model: string | undefined | null) =>
  !!model && claudeModelChoices.some((choice) => choice.model === model);

/** Claude Code names context-window variants with a suffix, e.g. `claude-opus-5-5[1m]`. */
export const claudeBaseModel = (model: string) =>
  model.replace(/\[[^\]]*\]$/, "");

export type ClaudeSelection = {
  model: string;
  effort: string;
  /** The exact model string Claude Code advertised for this account. */
  runtimeModel: string;
};

/**
 * The offered Claude models that this account's Claude Code actually lists,
 * with the efforts it advertises minus the withdrawn ones.
 */
export function claudeCatalogModels(listed: ModelInfo[]) {
  const runtime = new Map<string, string>();
  const models: CodexModel[] = [];
  for (const choice of claudeModelChoices) {
    const match = listed.find(
      (info) =>
        claudeBaseModel(info.resolvedModel ?? info.value) === choice.model,
    );
    if (!match) continue;
    runtime.set(choice.model, match.resolvedModel ?? match.value);
    models.push(
      catalogEntry(
        choice,
        (match.supportedEffortLevels ?? []).map((reasoningEffort) => ({
          reasoningEffort,
        })),
      ),
    );
  }
  return { models, runtime };
}

/** An entry with no efforts is listed but cannot be chosen, e.g. before Claude Code is signed in. */
function catalogEntry(
  choice: (typeof claudeModelChoices)[number],
  efforts: { reasoningEffort: string }[] = [],
): CodexModel {
  return {
    id: choice.model,
    model: choice.model,
    displayName: choice.displayName,
    provider: "claude",
    isDefault: false,
    defaultReasoningEffort: DEFAULT_EFFORT,
    supportedReasoningEfforts: offeredReasoningEfforts(efforts),
  };
}

export class ClaudeModelCatalog {
  private models = claudeModelChoices.map((choice) => catalogEntry(choice));
  private runtime = new Map<string, string>();
  private refreshedAt: string | null = null;
  private error: string | null = null;
  private inFlight?: Promise<void>;
  private attemptedAt = 0;

  constructor(
    private readonly list: () => Promise<ModelInfo[]>,
    private readonly read: (key: TunableKey) => number = (key) =>
      tunables[key].default,
  ) {}

  status() {
    return {
      models: this.models,
      refreshedAt: this.refreshedAt,
      refreshing: !!this.inFlight,
      error: this.error,
    };
  }
  get available() {
    return this.models.some((model) => model.supportedReasoningEfforts.length);
  }
  get refreshDue() {
    return (
      Date.now() - this.attemptedAt >=
      (this.refreshedAt && !this.error
        ? this.read("models.catalogCacheMin") * 60_000
        : this.read("models.catalogRetryS") * 1000)
    );
  }
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && !this.refreshDue) return Promise.resolve();
    this.attemptedAt = Date.now();
    this.inFlight = this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  /** Record a failure found outside the model list, such as a missing sign-in. */
  fail(reason: string) {
    this.error = reason;
  }
  resolve(requested: string, effort = DEFAULT_EFFORT): ClaudeSelection {
    if (this.error) throw new Error(this.error);
    const match = this.models.find((model) => model.model === requested);
    const runtimeModel = this.runtime.get(requested);
    if (!match || !runtimeModel)
      throw new Error(
        `Saved Claude Code model “${requested}” is unavailable. Choose another model in Settings; no substitute was selected.`,
      );
    if (!supportsReasoningEffort(match, effort))
      throw new Error(
        `Claude Code model “${requested}” does not support reasoning effort “${effort}”. Choose a supported effort in Settings; no substitute was selected.`,
      );
    return { model: match.model, effort, runtimeModel };
  }
  private async load() {
    try {
      const { models, runtime } = claudeCatalogModels(await this.list());
      if (!models.length)
        throw new Error(
          "Claude Code did not list Claude Fable 5.1 or Claude Opus 5.5 for this account.",
        );
      this.models = models;
      this.runtime = runtime;
      this.refreshedAt = new Date().toISOString();
      this.error = null;
    } catch (error) {
      this.error =
        error instanceof Error && error.message
          ? error.message
          : "Could not list Claude Code models.";
      throw error;
    }
  }
}
