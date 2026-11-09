import type { ModelSelection } from "../shared/model-selection.js";
import { prepareMessageModel } from "./message-model.js";
import {
  conversationCarryPrompt,
  startCarriedConversation,
  type ConversationCarry,
} from "./task-carry-over.js";
import type { WorkspaceContext } from "./server.js";
import { HttpError, MissingRecordError, now } from "./storage.js";
type MessageServices = Pick<
  WorkspaceContext,
  "store" | "agent" | "publish" | "taskOperation"
>;
export type MessageDeliveryOptions = {
  model?: string;
  guard?: () => void;
  beforeSend?: (activeTurnId?: string | null) => void | Promise<void>;
  acknowledged?: (result: unknown) => void | Promise<void>;
};

type LiveThread = ReturnType<
  WorkspaceContext["agent"]["status"]
>["threads"][number];

async function deliverMessage(
  { store, agent, publish }: MessageServices,
  id: string,
  threadId: string,
  live: LiveThread | undefined,
  prompt: string,
  requestId: string,
  options: MessageDeliveryOptions,
  selection?: ModelSelection,
  carryPrompt?: ConversationCarry,
) {
  options.guard?.();
  const latest = store.get("task", id);
  if (!latest) throw new MissingRecordError(404, "task", id, "Task missing");
  store.put("task", id, {
    ...latest,
    messages: [
      ...(latest.messages ?? []),
      {
        id: requestId,
        clientRequestId: requestId,
        role: "user",
        text: prompt,
        at: now(),
        delivery: "queued",
      },
    ],
    updatedAt: now(),
    version: latest.version + 1,
  });
  try {
    const result =
      carryPrompt && selection
        ? await startCarriedConversation(
            store,
            agent,
            id,
            carryPrompt,
            selection,
          )
        : live?.activeTurnId
          ? await agent.steer(threadId, prompt)
          : await agent.send(threadId, prompt, selection);
    if (options.acknowledged) await options.acknowledged(result);
    options.guard?.();
    confirmDelivery(store, agent, id, requestId, result);
    return { task: store.get("task", id), result };
  } catch (error) {
    if (error instanceof MissingRecordError) throw error;
    const after = store.get("task", id);
    if (!after) throw new MissingRecordError(404, "task", id, "Task missing");
    store.put("task", id, {
      ...after,
      error: String(error),
      status:
        carryPrompt || !agent.status().connected
          ? "disconnected"
          : after.status,
      messages: after.messages.map((m) =>
        m.id === requestId ? { ...m, delivery: "unknown" } : m,
      ),
      updatedAt: now(),
      version: after.version + 1,
    });
    store.autoExport();
    publish("state");
    throw error;
  }
}

function confirmDelivery(
  store: MessageServices["store"],
  agent: MessageServices["agent"],
  id: string,
  requestId: string,
  result: unknown,
) {
  const after = store.get("task", id);
  if (!after) throw new MissingRecordError(404, "task", id, "Task missing");
  const current = agent
    .status()
    .threads.find((thread) => thread.id === after.threadId);
  store.put("task", id, {
    ...after,
    messages: after.messages.map((m) =>
      m.id === requestId
        ? {
            ...m,
            delivery: "sent",
            model: current?.model,
            effort: current?.effort,
            turnId:
              result &&
              typeof result === "object" &&
              "turnId" in result &&
              typeof result.turnId === "string"
                ? result.turnId
                : m.turnId,
          }
        : m,
    ),
    status: after.pendingRequests?.length
      ? after.status
      : current?.activeTurnId
        ? "running"
        : after.status,
    activeTurnId: current?.activeTurnId ?? null,
    updatedAt: now(),
    version: after.version + 1,
  });
}

export function sendTaskMessage(
  ctx: MessageServices,
  id: string,
  prompt: string,
  requestId: string,
  options: MessageDeliveryOptions = {},
) {
  const { taskOperation, store, agent } = ctx;
  return taskOperation(id, async () => {
    options.guard?.();
    const t = store.get("task", id);
    if (!t) throw new MissingRecordError(404, "task", id, "Task missing");
    if (t?.documentResult?.status === "rendering")
      throw new HttpError(
        409,
        "Wait for PDF generation to finish before another revision",
      );
    if (!t?.threadId)
      throw new HttpError(
        400,
        "Live thread unavailable. Start the saved task or export its handoff.",
      );
    const existing = (t.messages ?? []).find(
      (m) => m.clientRequestId === requestId,
    );
    if (existing)
      return {
        task: t,
        result: { duplicate: true, delivery: existing.delivery },
      };
    await agent.connect();
    if (!agent.status().available)
      throw new HttpError(503, agent.status().reason ?? "Codex is unavailable");
    const { live, selection, carry } = await prepareMessageModel(
      agent,
      store,
      { ...t, threadId: t.threadId },
      options.model,
    );
    const carryPrompt = carry
      ? await conversationCarryPrompt(store, agent, t, prompt)
      : undefined;
    if (options.beforeSend) await options.beforeSend(live?.activeTurnId);
    return deliverMessage(
      ctx,
      id,
      t.threadId,
      live,
      prompt,
      requestId,
      options,
      selection,
      carryPrompt,
    );
  });
}
