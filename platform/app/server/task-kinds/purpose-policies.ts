import {
  openingResearchInstructions,
  scopedToolInstructions,
} from "../opening-research-policy.js";
import {
  applicationAnswerInstructions,
  applicationAnswersTool,
  applicationReviewInstructions,
} from "../application-answers.js";
import { contextReadTool, contextWriteTool } from "../context-tools.js";
import { greenhouseSkipTool } from "../greenhouse-pull.js";
import {
  followUpEmailInstructions,
  followUpEmailTool,
} from "../follow-up-email-task.js";
import { openingResearchTool } from "../opening-workflow.js";
import {
  documentInstructions,
  questionInstructions,
} from "../question-context.js";

export type TaskPurpose =
  | "questions"
  | "documents"
  | "opening-research"
  | "application-answers"
  | "follow-up-email";

export type PurposePolicy = {
  sandbox: "read-only";
  web_search: "live" | "disabled";
  developerInstructions: string;
  dynamicTools: () => unknown[];
};

const followUpToolInstructions =
  " Use read_job_search_source to read the supplied files and save_follow_up_email to save the draft. Shell and MCP tools are disabled. Never claim a file was read or a draft was saved without a successful tool result.";
export const TASK_PURPOSE_POLICIES = {
  questions: {
    sandbox: "read-only",
    web_search: "live",
    developerInstructions: questionInstructions + scopedToolInstructions,
    dynamicTools: () => [contextReadTool],
  },
  documents: {
    sandbox: "read-only",
    web_search: "disabled",
    developerInstructions: documentInstructions() + scopedToolInstructions,
    dynamicTools: () => [contextReadTool, contextWriteTool],
  },
  "opening-research": {
    sandbox: "read-only",
    web_search: "live",
    developerInstructions: openingResearchInstructions + scopedToolInstructions,
    dynamicTools: () => [
      contextReadTool,
      openingResearchTool,
      greenhouseSkipTool,
    ],
  },
  "application-answers": {
    sandbox: "read-only",
    web_search: "disabled",
    developerInstructions:
      questionInstructions +
      "\n\n" +
      applicationAnswerInstructions +
      "\n\n" +
      applicationReviewInstructions +
      scopedToolInstructions,
    dynamicTools: () => [contextReadTool, applicationAnswersTool],
  },
  "follow-up-email": {
    sandbox: "read-only",
    web_search: "live",
    developerInstructions: followUpEmailInstructions + followUpToolInstructions,
    dynamicTools: () => [contextReadTool, followUpEmailTool],
  },
} satisfies Record<TaskPurpose, PurposePolicy>;

const workspaceInstructions =
  "You are working on an explicitly requested local job-search task. Follow the copied AGENTS.md and context manifest. Write only inside this isolated draft directory. Never edit the repository source masters or Codex configuration. Preserve evidence and private/public resume consistency. Produce a revision bundle and run the supplied validators before describing it as ready. The application will validate and deliberately promote artifacts separately. Do not stage, commit, push, publish, purchase, submit applications, or send messages to employers without separate explicit user authorization. Never inspect unrelated conversations, private browser sessions, credentials, private documents or raw archives. Browser tasks must use browser_clean. Do not launch browsers from the shell.";

export type TaskPolicyMetadata = {
  sandbox: "read-only" | "workspace-write";
  instructions: string;
  tools?: () => unknown[];
};

function isTaskPurpose(value: string): value is TaskPurpose {
  return Object.prototype.hasOwnProperty.call(TASK_PURPOSE_POLICIES, value);
}

export function purposePolicy(purpose: TaskPurpose | string) {
  return isTaskPurpose(purpose)
    ? TASK_PURPOSE_POLICIES[purpose]
    : TASK_PURPOSE_POLICIES.documents;
}

export function taskPolicyMetadata(
  purpose: TaskPurpose | string | undefined,
): TaskPolicyMetadata {
  if (!purpose)
    return {
      sandbox: "workspace-write",
      instructions: workspaceInstructions,
    };
  const policy = purposePolicy(purpose);
  return {
    sandbox: policy.sandbox,
    instructions: policy.developerInstructions,
    tools: policy.dynamicTools,
  };
}

export function purposeDynamicTools(purpose: TaskPurpose | string) {
  return purposePolicy(purpose).dynamicTools();
}

function purposeThreadOptions(
  cwd: string,
  effort: string,
  purpose: TaskPurpose | string,
  mcpNames: string[],
) {
  const policy = purposePolicy(purpose);
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    sandbox: policy.sandbox,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: {
      model_reasoning_effort: effort,
      web_search: policy.web_search,
      features: {
        shell_tool: false,
        unified_exec: false,
        code_mode_host: false,
        view_image: false,
        multi_agent: false,
        apps: false,
        plugins: false,
        remote_plugin: false,
      },
      mcp_servers: Object.fromEntries(
        mcpNames.map((name) => [name, { enabled: false }]),
      ),
    },
    developerInstructions: policy.developerInstructions,
  };
}

function workspaceThreadOptions(cwd: string, effort: string) {
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    config: {
      model_reasoning_effort: effort,
      sandbox_workspace_write: {
        writable_roots: [cwd],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    },
    developerInstructions: workspaceInstructions,
  };
}

export function taskThreadOptions(
  cwd: string,
  effort: string,
  purpose: TaskPurpose | string | undefined,
  mcpNames: string[],
) {
  return purpose
    ? purposeThreadOptions(cwd, effort, purpose, mcpNames)
    : workspaceThreadOptions(cwd, effort);
}
