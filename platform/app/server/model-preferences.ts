import {
  DEFAULT_EFFORT,
  isModelRequestType,
  modelProvider,
  modelRequestTypes,
  supportsReasoningEffort,
  type ModelPreferences,
  type EffortPreferences,
  type ModelCatalogStatus,
} from "../shared/codex-models.js";
import type { AppState } from "../shared/types.js";
import { HttpError } from "./storage.js";

type Preferences = Pick<AppState["settings"], "codexModels" | "codexEfforts">;

function parsePreferences(
  value: unknown,
  field: "codexModels" | "codexEfforts",
) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${field} must be an object.`);
  const parsed: ModelPreferences = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !isModelRequestType(key) ||
      typeof entry !== "string" ||
      entry.length > (field === "codexModels" ? 150 : 30)
    )
      throw new HttpError(
        400,
        `Unknown request type or invalid ${field === "codexModels" ? "model" : "effort"}.`,
      );
    if (entry) parsed[key] = entry;
  }
  return parsed;
}

export function validateModelPreferences(
  models: unknown,
  efforts: unknown,
  previous: Preferences,
  catalog: ModelCatalogStatus,
) {
  const codexModels = parsePreferences(models, "codexModels");
  const codexEfforts = parsePreferences(
    efforts === undefined ? (previous.codexEfforts ?? {}) : efforts,
    "codexEfforts",
  );
  for (const key of modelRequestTypes) {
    const model = codexModels[key];
    const effort = codexEfforts[key] || DEFAULT_EFFORT;
    // Unchanged unavailable pairs remain editable alongside other request types.
    if (
      (previous.codexModels?.[key] || "") === (model || "") &&
      (previous.codexEfforts?.[key] || DEFAULT_EFFORT) === effort
    )
      continue;
    if (!model && !codexEfforts[key]) continue;
    const matches = catalog.models.filter(
      (m) => !m.hidden && (model ? m.model === model : m.isDefault),
    );
    const providerError =
      matches.length === 1 && modelProvider(matches[0]) !== "codex"
        ? catalog.providerErrors?.[modelProvider(matches[0])]
        : catalog.error;
    if (
      providerError ||
      matches.length !== 1 ||
      !supportsReasoningEffort(matches[0], effort)
    )
      throw new HttpError(
        400,
        `Choose an available model and supported reasoning effort for this request type (${key}). Refresh the model list if needed.`,
      );
  }
  return { codexModels, codexEfforts };
}
