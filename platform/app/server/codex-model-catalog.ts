import { tunables, type TunableKey } from "../shared/tunables.js";
import {
  DEFAULT_EFFORT,
  hideSupersededModels,
  offeredReasoningEfforts,
  supportsReasoningEffort,
  type CodexModel,
  type ModelCatalogStatus,
} from "../shared/codex-models.js";

export const MODEL_UNAVAILABLE =
  "Codex must recommend exactly one available default model. No substitute will be selected; refresh the connection or choose a model and effort in Settings.";

/** Codex models Fieldwork no longer offers: every GPT-5.x model and GPT-6-Luna. */
export function withdrawnCodexModel(model: Pick<CodexModel, "id" | "model">) {
  return [model.id, model.model].some(
    (name) => /^gpt-5(?:[.-]|$)/i.test(name) || /^gpt-6-luna$/i.test(name),
  );
}

function offeredModel(model: CodexModel): CodexModel {
  return {
    ...model,
    supportedReasoningEfforts: offeredReasoningEfforts(
      model.supportedReasoningEfforts,
    ),
  };
}

function parseModel(value: unknown): CodexModel {
  if (!value || typeof value !== "object")
    throw new Error("Invalid Codex model catalog.");
  const m = value as Record<string, unknown>;
  if (
    typeof m.id !== "string" ||
    !m.id ||
    typeof m.model !== "string" ||
    !m.model ||
    typeof m.displayName !== "string" ||
    typeof m.defaultReasoningEffort !== "string" ||
    typeof m.isDefault !== "boolean" ||
    !Array.isArray(m.supportedReasoningEfforts)
  )
    throw new Error("Invalid Codex model catalog.");
  const efforts = m.supportedReasoningEfforts.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("reasoningEffort" in entry) ||
      typeof entry.reasoningEffort !== "string" ||
      !entry.reasoningEffort ||
      entry.reasoningEffort.length > 30
    )
      throw new Error("Invalid Codex reasoning effort.");
    return {
      reasoningEffort: entry.reasoningEffort,
      ...("description" in entry && typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    };
  });
  return {
    id: m.id,
    model: m.model,
    displayName: m.displayName,
    hidden: m.hidden === true,
    defaultReasoningEffort: m.defaultReasoningEffort,
    isDefault: m.isDefault,
    supportedReasoningEfforts: efforts,
  };
}

export class CodexModelCatalog {
  private models: CodexModel[] = [];
  private refreshedAt: string | null = null;
  private error: string | null = null;
  private inFlight?: Promise<void>;
  private attemptedAt = 0;
  private valid = false;
  private warming?: Promise<void>;
  private warmAttemptedAt = 0;

  constructor(
    private readonly list: (cursor: string | null) => Promise<unknown>,
    private readonly read: (key: TunableKey) => number = (key) =>
      tunables[key].default,
  ) {}

  status(connection?: {
    connecting: boolean;
    available: boolean;
    reason: string | null;
  }): ModelCatalogStatus {
    return {
      models: this.models,
      refreshedAt: this.refreshedAt,
      refreshing: !!this.inFlight || !!this.warming || !!connection?.connecting,
      error:
        this.error ||
        (connection && !connection.available ? connection.reason : null),
    };
  }
  warm(
    connect: () => Promise<unknown>,
    connected: () => boolean,
    refresh: () => Promise<void>,
  ) {
    if (this.warming) return this.warming;
    if (connected() && !this.refreshDue) return Promise.resolve();
    if (
      !connected() &&
      Date.now() - this.warmAttemptedAt <
        this.read("models.catalogRetryS") * 1000
    )
      return Promise.resolve();
    this.warmAttemptedAt = Date.now();
    this.warming = connect()
      .then(async () => {
        if (connected()) await refresh();
      })
      .finally(() => {
        this.warming = undefined;
      });
    return this.warming;
  }
  get available() {
    return (
      this.valid &&
      this.models.some((model) => model.supportedReasoningEfforts.length > 0)
    );
  }
  get selected() {
    try {
      return this.resolve();
    } catch {
      return null;
    }
  }
  resolve(requested?: string, effort = DEFAULT_EFFORT) {
    if (!this.valid) throw new Error(this.error || MODEL_UNAVAILABLE);
    const matches = this.models.filter((m) =>
      requested ? m.model === requested || m.id === requested : m.isDefault,
    );
    if (matches.length !== 1)
      throw new Error(
        requested
          ? `Saved Codex model “${requested}” is unavailable. Choose another model in Settings; no substitute was selected.`
          : MODEL_UNAVAILABLE,
      );
    if (!supportsReasoningEffort(matches[0], effort))
      throw new Error(
        `Codex model “${matches[0].model}” does not support reasoning effort “${effort}”. Choose a supported effort in Settings; no substitute was selected.`,
      );
    return { model: matches[0].model, effort };
  }
  get refreshDue() {
    return (
      Date.now() - this.attemptedAt >=
      (this.valid
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
  private async load() {
    try {
      const models: CodexModel[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const raw = await this.list(cursor);
        if (
          !raw ||
          typeof raw !== "object" ||
          !("data" in raw) ||
          !Array.isArray(raw.data)
        )
          throw new Error("Invalid Codex model catalog.");
        models.push(...raw.data.map(parseModel));
        const next = "nextCursor" in raw ? raw.nextCursor : null;
        if (next != null && typeof next !== "string")
          throw new Error("Invalid model cursor.");
        cursor = next || null;
        if (
          cursor &&
          (seen.has(cursor) || models.length >= 1000 || seen.size >= 100)
        )
          throw new Error("Codex returned an incomplete model catalog.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (
        !models.length ||
        new Set(models.map((m) => m.id)).size !== models.length
      )
        throw new Error("Codex returned an empty or duplicate model catalog.");
      this.models = hideSupersededModels(
        models.filter((model) => !withdrawnCodexModel(model)).map(offeredModel),
      );
      this.refreshedAt = new Date().toISOString();
      this.valid = true;
      this.error = null;
    } catch (error) {
      this.valid = false;
      this.error =
        "Could not refresh Codex models. The last list is retained; refresh before starting a new request.";
      throw error;
    }
  }
}
