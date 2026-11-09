import { claudeCredentialPaths } from "./session.js";
import type {
  McpSdkServerConfigWithInstance,
  PermissionMode,
  SandboxSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  purposePolicy,
  taskPolicyMetadata,
  type TaskPurpose,
} from "../task-kinds/purpose-policies.js";
import { claudeToolResultChars } from "../context-source-limits.js";

/** In-process MCP server name; Claude Code exposes its tools as `mcp__fieldwork__<tool>`. */
export const CLAUDE_TOOL_SERVER = "fieldwork";
export const claudeToolName = (tool: string) =>
  `mcp__${CLAUDE_TOOL_SERVER}__${tool}`;

type DynamicTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  _meta: { "anthropic/maxResultSizeChars": number };
};

function dynamicTool(value: unknown): DynamicTool {
  const tool = value as Partial<DynamicTool> | null;
  if (
    !tool ||
    typeof tool.name !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) ||
    typeof tool.description !== "string" ||
    tool.inputSchema?.type !== "object"
  )
    throw new Error("Invalid task tool definition for Claude Code.");
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    _meta: { "anthropic/maxResultSizeChars": claudeToolResultChars },
  };
}

export type ClaudeToolCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<CallToolResult>;

/**
 * Serve a task's dynamic tools (the same JSON-schema definitions Codex
 * receives) to one Claude Code session, calling back into Fieldwork.
 */
export function claudeToolServer(
  tools: unknown[],
  call: ClaudeToolCall,
): McpSdkServerConfigWithInstance {
  const definitions = tools.map(dynamicTool);
  const server = new McpServer(
    { name: CLAUDE_TOOL_SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions,
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!definitions.some((tool) => tool.name === request.params.name))
      return {
        isError: true,
        content: [{ type: "text", text: "This task has no such tool." }],
      };
    return call(request.params.name, request.params.arguments ?? {});
  });
  return { type: "sdk", name: CLAUDE_TOOL_SERVER, instance: server };
}

export type ClaudeSessionPolicy = {
  /** Built-in Claude Code tools the model can see; everything else is removed. */
  tools: string[];
  /** Tools that run without a permission prompt. */
  allowedTools: string[];
  /** Tools the approval handler allows without asking (kept out of `allowedTools`, which would bypass it). */
  autoApprove: string[];
  permissionMode: PermissionMode;
  /** Whether prompts the mode cannot settle reach the user as approval requests. */
  approvals: boolean;
  sandbox?: SandboxSettings;
  dynamicTools: unknown[];
  instructions: string;
};

/** Built-in tools for ordinary draft-directory tasks, the counterpart of Codex workspace-write. */
const workspaceTools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

/**
 * Claude Code's version of a task's Codex sandbox. Purpose tasks get only
 * their Fieldwork tools (plus server-side web search where Codex has live
 * search); ordinary tasks may edit their draft directory and run sandboxed
 * shell commands with no network, and anything else asks the user.
 */
export function claudeSessionPolicy(
  purpose: TaskPurpose | undefined,
): ClaudeSessionPolicy {
  if (purpose) {
    const policy = purposePolicy(purpose);
    const dynamicTools = policy.dynamicTools();
    const web = policy.web_search === "live" ? ["WebSearch"] : [];
    return {
      tools: web,
      allowedTools: [
        ...web,
        ...dynamicTools.map((tool) => claudeToolName(dynamicTool(tool).name)),
      ],
      autoApprove: [],
      permissionMode: "dontAsk",
      approvals: false,
      dynamicTools,
      instructions: policy.developerInstructions,
    };
  }
  return {
    tools: [...workspaceTools, "WebSearch"],
    allowedTools: [],
    autoApprove: ["Read", "Glob", "Grep", "WebSearch"],
    permissionMode: "acceptEdits",
    approvals: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      credentials: {
        files: claudeCredentialPaths().map((path) => ({
          path,
          mode: "deny" as const,
        })),
        envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }],
      },
    },
    dynamicTools: [],
    instructions: taskPolicyMetadata(undefined).instructions,
  };
}
