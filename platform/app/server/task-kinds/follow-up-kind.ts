import {
  followUpPrompt,
  prepareFollowUpBundle,
} from "../follow-up-email-task.js";
import type { TaskKindConfig } from "./registry.js";
import { followUpSourceTools } from "./source-tools.js";
import { completeFollowUpEmail } from "./task-completion.js";

/** Follow-up email drafting: a small evidence snapshot, the save tool, and web search for a published recruiting address. */
export const followUpKindConfig: TaskKindConfig = {
  purpose: () => "follow-up-email",
  prepareBundle: (store, task) => prepareFollowUpBundle(store, task),
  initialize: () => undefined,
  taskFields: (services, request) => ({
    title: `Follow-up email · ${services.string(request.body.postingLabel ?? "", 150).trim() || "application"}`,
    modelPolicy: "codex-default",
  }),
  prompt: followUpPrompt,
  onTurnCompleted: { afterAutofill: completeFollowUpEmail },
  questionLike: false,
  requiresPosting: false,
  collectArtifacts: false,
  sourceTools: followUpSourceTools,
};
