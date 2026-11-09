import InfoTooltip from "../ui/InfoTooltip";
import {
  recordedAgentLabel,
  taskModelRequestType,
  type EffortPreferences,
  type ModelPreferences,
} from "../../shared/codex-models";
import {
  configuredSelection,
  defaultSelectionLabel,
  modelLabel,
  type ModelSelection,
} from "../../shared/model-selection";

export function QuestionModelBadge({
  preferences,
  efforts,
  fallback,
}: {
  preferences?: ModelPreferences;
  efforts?: EffortPreferences;
  fallback?: ModelSelection | null;
}) {
  return (
    <span className="badge" data-testid="model-selection">
      {preferences?.questions || efforts?.questions ? "Saved" : "Auto"}: {modelLabel(
        configuredSelection(preferences, "questions", fallback, efforts),
        defaultSelectionLabel(efforts, "questions"),
      )}
    </span>
  );
}

export type NextTurnModelTask = Parameters<typeof taskModelRequestType>[0] & {
  threadId?: string | null;
  model?: string;
  effort?: string;
};

/** Match the server's existing provider pinning when no per-message override is sent. */
export function nextTurnSelection(
  preferences: ModelPreferences | undefined,
  efforts: EffortPreferences | undefined,
  task: NextTurnModelTask,
  fallback?: ModelSelection | null,
): ModelSelection | null {
  const selected = configuredSelection(
    preferences,
    taskModelRequestType(task),
    fallback,
    efforts,
  );
  const model = task.model;
  const pinned =
    !!task.threadId &&
    !!model &&
    !!selected &&
    recordedAgentLabel(model) !== recordedAgentLabel(selected.model);
  if (!pinned || !model) return selected;
  return {
    model,
    effort: task.effort || selected.effort,
  };
}

export function NextTurnModel({
  preferences,
  efforts,
  task,
  fallback,
}: {
  preferences?: ModelPreferences;
  efforts?: EffortPreferences;
  task: NextTurnModelTask;
  fallback?: ModelSelection | null;
}) {
  const request = taskModelRequestType(task);
  return (
    <span className="tiny muted">
      Next turn: {modelLabel(
        nextTurnSelection(preferences, efforts, task, fallback),
        defaultSelectionLabel(efforts, request),
      )}{" "}
      <InfoTooltip label="About follow-up context">
        Follow-ups use the same saved sources and posting.
      </InfoTooltip>
    </span>
  );
}
