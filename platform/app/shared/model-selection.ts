import {
  configuredEffort,
  type EffortPreferences,
  type ModelPreferences,
  type ModelRequestType,
} from "./codex-models.js";
export type ModelSelection = { model: string; effort: string };

export function configuredSelection(
  preferences: ModelPreferences | undefined,
  request: ModelRequestType,
  fallback: ModelSelection | null | undefined,
  efforts?: EffortPreferences,
) {
  const model = preferences?.[request] || fallback?.model;
  return model ? { model, effort: configuredEffort(efforts, request) } : null;
}

export const defaultSelectionLabel = (
  efforts: EffortPreferences | undefined,
  request: ModelRequestType,
) => `Codex default · ${configuredEffort(efforts, request)}`;

type SelectionValue = { model?: unknown; effort?: unknown };
type SelectionParams = SelectionValue & {
  item?: { id?: string };
  turnId?: string;
  turn?: { id?: string };
};
export type SelectionEvent = {
  method: string;
  turnId?: string;
  selection?: SelectionValue;
  params?: SelectionParams;
};
type SelectionTask = {
  turnSelections?: Record<string, ModelSelection>;
  modelConfirmed?: boolean;
  model?: unknown;
  effort?: unknown;
};
type SelectionMessage = SelectionValue & {
  itemId?: string;
  turnId?: string;
};

export function recordedSelection(
  value: SelectionValue | null | undefined,
): ModelSelection | null {
  return typeof value?.model === "string" &&
    value.model &&
    typeof value?.effort === "string" &&
    value.effort
    ? { model: value.model, effort: value.effort }
    : null;
}

export function modelLabel(
  value: SelectionValue | null | undefined,
  unknown = "Model not recorded",
) {
  const selection = recordedSelection(value);
  return selection ? `${selection.model} · ${selection.effort}` : unknown;
}

/** Use each turn's recorded events; never attribute an old answer to today's default. */
export function turnSelections(
  task: SelectionTask | null | undefined,
  events: readonly SelectionEvent[] = [],
): Record<string, ModelSelection> {
  const selections = { ...(task?.turnSelections ?? {}) };
  let current: ModelSelection | null = null;
  for (const event of events) {
    if (
      ["adapter/threadCreated", "adapter/threadResumed"].includes(event.method)
    )
      current = recordedSelection(event.params) ?? current;
    const selection = recordedSelection(event.selection) ?? current;
    const id = event.turnId ?? event.params?.turnId ?? event.params?.turn?.id;
    if (id && selection && !selections[id]) selections[id] = selection;
  }
  return selections;
}

export function messageSelection(
  task: SelectionTask | null | undefined,
  message: SelectionMessage,
  events: readonly SelectionEvent[] = [],
): ModelSelection | null {
  const recorded = recordedSelection(message);
  if (recorded) return recorded;
  const event = events.find(
    (e) => message?.itemId && e.params?.item?.id === message.itemId,
  );
  const turnId = message?.turnId ?? event?.turnId ?? event?.params?.turnId;
  return turnId ? (turnSelections(task, events)[turnId] ?? null) : null;
}

export function taskSelection(
  task: SelectionTask | null | undefined,
  events: readonly SelectionEvent[] = [],
): ModelSelection | null {
  if (task?.modelConfirmed) return recordedSelection(task);
  for (const event of [...events].reverse()) {
    if (
      ["adapter/threadCreated", "adapter/threadResumed"].includes(event.method)
    ) {
      const selection = recordedSelection(event.params);
      if (selection) return selection;
    }
  }
  return null;
}
