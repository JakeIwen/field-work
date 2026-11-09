import { isTaskTurnActive } from "../../shared/types.js";
import type { Bundle, Task } from "../../shared/task-records.js";
import { stageApplicationAnswers } from "../application-answers.js";
import type { contextTool } from "../context-tools.js";
import { stageGreenhouseDecision } from "../greenhouse-pull.js";
import { stageFollowUpDraft } from "../follow-up-email.js";
import { validateOpeningResearch } from "../opening-workflow.js";
import { HttpError, type Store } from "../storage.js";

type RawToolArgs = Parameters<typeof contextTool>[3];
export type SourceToolResult = ReturnType<typeof contextTool>;

export type SourceToolDispatch =
  { handled: false } | { handled: true; result: SourceToolResult };

export type SourceToolPolicy = {
  eligible: boolean;
  dispatch?: (
    store: Store,
    task: Task,
    tool: string,
    args: RawToolArgs,
  ) => SourceToolDispatch;
  allowedWritePaths?: (task: Task, bundle: Bundle) => (string | undefined)[];
};

export const noSourceTools: SourceToolPolicy = { eligible: false };
export const questionsSourceTools: SourceToolPolicy = {
  eligible: true,
  dispatch: dispatchQuestionTool,
};
export const researchSourceTools: SourceToolPolicy = {
  eligible: true,
  dispatch: dispatchResearchTool,
};
export const coverLetterSourceTools: SourceToolPolicy = {
  eligible: true,
  allowedWritePaths: () => ["cover_letter.txt"],
};
export const resumeSourceTools: SourceToolPolicy = {
  eligible: true,
  allowedWritePaths: resumeWritePaths,
};
export const applicationSourceTools: SourceToolPolicy = {
  eligible: true,
  allowedWritePaths: (_task, bundle) => [
    "cover_letter.txt",
    ...resumeWritePaths(_task, bundle),
  ],
};
export const followUpSourceTools: SourceToolPolicy = {
  eligible: true,
  dispatch: dispatchFollowUpTool,
};
function dispatchResearchTool(
  store: Store,
  task: Task,
  tool: string,
  args: RawToolArgs,
): SourceToolDispatch {
  if (tool === "save_opening_research") {
    if (task.greenhousePull)
      return {
        handled: true,
        result: stageGreenhouseDecision(store, task, args),
      };
    if (!isTaskTurnActive(task.status))
      throw new HttpError(409, "Research needs an active turn");
    const researchResult = validateOpeningResearch(store, args);
    store.put("task", task.id, { ...task, researchResult });
    store.autoExport();
    return {
      handled: true,
      result: {
        saved: true,
        message:
          "Research saved. The Opening will be published when this turn completes.",
      },
    };
  }
  if (tool === "skip_greenhouse_opening")
    return {
      handled: true,
      result: stageGreenhouseDecision(store, task, args, true),
    };
  return { handled: false };
}

function dispatchFollowUpTool(
  store: Store,
  task: Task,
  tool: string,
  args: RawToolArgs,
): SourceToolDispatch {
  if (tool !== "save_follow_up_email") return { handled: false };
  if (!isTaskTurnActive(task.status))
    throw new HttpError(409, "Saving a follow-up draft needs an active turn");
  return { handled: true, result: stageFollowUpDraft(store, task, args) };
}

function dispatchQuestionTool(
  store: Store,
  task: Task,
  tool: string,
  args: RawToolArgs,
): SourceToolDispatch {
  if (tool === "save_application_answers" && task.autofillContext)
    return {
      handled: true,
      result: stageApplicationAnswers(store, task, args),
    };
  return { handled: false };
}

function resumeWritePaths(_task: Task, bundle: Bundle) {
  return [
    bundle.master,
    `${bundle.versionDir}/resume.md`,
    `${bundle.versionDir}/revision_notes.md`,
    ...(bundle.privateOnly ? [] : ["source_data/github_evidence_dossier.md"]),
    ...bundle.paths.filter(
      (path) =>
        path.startsWith(bundle.versionDir + "/") && path.endsWith(".html"),
    ),
  ];
}
