import { sendTaskMessage } from "./task-followup.js";
import {
  acknowledgeOverflowTurn,
  recordIndependentOverflowRequest,
} from "./overflow-recovery-ownership.js";
import { reconcileDocumentPublication } from "./task-kinds/task-completion.js";

type MessageServices = Parameters<typeof sendTaskMessage>[0];

async function acknowledged(
  services: MessageServices,
  id: string,
  requestId: string,
  result: unknown,
) {
  const turnId = acknowledgeOverflowTurn(services.store, id, requestId, result);
  if (turnId) await reconcileDocumentPublication(services, id);
}

export function sendOverflowFollowup(
  services: MessageServices,
  id: string,
  prompt: string,
  requestId: string,
  guard: () => void,
) {
  return sendTaskMessage(services, id, prompt, requestId, {
    guard,
    acknowledged: (result) => acknowledged(services, id, requestId, result),
  });
}

export function sendUserTaskMessage(
  services: MessageServices,
  id: string,
  prompt: string,
  requestId: string,
  model?: string,
) {
  return sendTaskMessage(services, id, prompt, requestId, {
    model,
    beforeSend(activeTurnId) {
      if (!activeTurnId)
        recordIndependentOverflowRequest(services.store, id, requestId);
    },
    acknowledged: (result) => acknowledged(services, id, requestId, result),
  });
}
