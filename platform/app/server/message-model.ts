import type { Task } from "../shared/types.js";
import {
  DEFAULT_EFFORT,
  recordedAgentLabel,
  taskModelRequestType,
  configuredEffort,
  modelProvider,
  supportsReasoningEffort,
  type ModelRequestType,
} from "../shared/codex-models.js";
import type { AgentRouter } from "./agent-router.js";
import { withdrawnCodexModel } from "./codex-model-catalog.js";
import { HttpError, type Store } from "./storage.js";

/** An omitted override preserves the existing default/thread selection policy. */
export function parseMessageModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 150)
    throw new HttpError(400, "Choose an available model for this message.");
  return value;
}

export async function resolveMessageModel(
  agent: AgentRouter,
  store: Store,
  requestType: ModelRequestType,
  requested: string,
) {
  await agent.warmModels();
  const catalog = agent.modelCatalogStatus();
  const matches = catalog.models.filter(
    (model) =>
      !model.hidden && model.model === requested && !withdrawnCodexModel(model),
  );
  const model = matches.length === 1 ? matches[0] : undefined;
  const error =
    model && modelProvider(model) === "claude"
      ? catalog.providerErrors?.claude
      : catalog.error;
  if (!model || error)
    throw new HttpError(
      400,
      `Model “${requested}” is unavailable. Refresh the model list and choose another; no substitute was selected.`,
    );
  const savedEffort = configuredEffort(
    store.settings().codexEfforts,
    requestType,
  );
  const effort = supportsReasoningEffort(model, savedEffort)
    ? savedEffort
    : DEFAULT_EFFORT;
  if (!supportsReasoningEffort(model, effort))
    throw new HttpError(
      400,
      `Model “${requested}” does not offer the saved effort or High. No turn was started.`,
    );
  return { model: model.model, effort };
}

/** Resolve an override before resuming: a retired default must not block choosing a valid model. */
export async function prepareMessageModel(
  agent: AgentRouter,
  store: Store,
  task: Task & { threadId: string },
  requested?: string,
) {
  const known = agent
    .status()
    .threads.find((thread) => thread.id === task.threadId);
  const needsResume =
    !known || known.uncertain || task.status === "disconnected";
  const selection =
    requested && (!known?.activeTurnId || needsResume)
      ? await resolveMessageModel(
          agent,
          store,
          taskModelRequestType(task),
          requested,
        )
      : undefined;
  const carry =
    !!selection &&
    recordedAgentLabel(selection.model) !==
      recordedAgentLabel(known?.model ?? task.model);
  // Carry-over reads the old transcript without requiring its old model to remain available.
  if (needsResume && !carry) await agent.resume(task.threadId, selection);
  const live = agent
    .status()
    .threads.find((thread) => thread.id === task.threadId);
  return {
    live,
    selection: live?.activeTurnId && !carry ? undefined : selection,
    carry,
  };
}
