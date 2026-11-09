import {
  DEFAULT_EFFORT,
  taskModelRequestType,
  type ModelRequestType,
} from "../shared/codex-models.js";
import type { ModelSelection } from "../shared/model-selection.js";
import type { CodexModelCatalog } from "./codex-model-catalog.js";
import type { TaskPurpose } from "./task-kinds/purpose-policies.js";
import type { Store } from "./storage.js";

type PreferenceReader = (
  requestType?: ModelRequestType,
  threadId?: string,
) => string | undefined;
export type CodexSelectionPreferences = {
  modelPreference?: PreferenceReader;
  effortPreference?: PreferenceReader;
};
export type CodexStartRequest = Partial<ModelSelection> & {
  prompt: string;
  /** Per-message selections must not pin subsequent turns. */
  transientModel?: boolean;
  /** Register ownership before any event or tool can arrive. Internal callers only. */
  onThreadCreated?: (threadId: string) => void;
  cwd?: string;
  purpose?: TaskPurpose;
  requestType?: ModelRequestType;
};
export type ManagedThread = {
  id: string;
  cwd: string;
  model: string;
  effort: string;
  createdAt: string;
  activeTurnId?: string;
  uncertain?: boolean;
  purpose?: TaskPurpose;
  requestType?: ModelRequestType;
  modelOverride?: string;
  effortOverride?: string;
};

export function resolveCodexSelection(
  catalog: CodexModelCatalog,
  preferences: CodexSelectionPreferences,
  requestType?: ModelRequestType,
  threadId?: string,
  overrides: Partial<ModelSelection> = {},
) {
  return catalog.resolve(
    overrides.model ?? preferences.modelPreference?.(requestType, threadId),
    overrides.effort ??
      preferences.effortPreference?.(requestType, threadId) ??
      DEFAULT_EFFORT,
  );
}

export function codexPreferences(store: Store): CodexSelectionPreferences {
  const reader =
    (field: "codexModels" | "codexEfforts"): PreferenceReader =>
    (requestType, threadId) => {
      const task = threadId ? store.taskForThread(threadId) : undefined;
      const key =
        requestType ?? (task ? taskModelRequestType(task) : undefined);
      return key ? store.settings()[field]?.[key] : undefined;
    };
  return {
    modelPreference: reader("codexModels"),
    effortPreference: reader("codexEfforts"),
  };
}
