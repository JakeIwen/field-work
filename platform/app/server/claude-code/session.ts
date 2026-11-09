import { homedir } from "node:os";
import path from "node:path";
import type {
  AccountInfo,
  ModelInfo,
  Options,
  Query,
  SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { maxContextSourceTokens } from "../context-source-limits.js";

export type ClaudeQuery = typeof sdkQuery;

/** A prompt stream that stays open while a turn may still be steered. */
export class ClaudeInput {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(uuid: string, text: string) {
    if (this.closed) throw new Error("This Claude Code turn has ended.");
    this.queue.push({
      type: "user",
      uuid: uuid as SDKUserMessage["uuid"],
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: text },
    });
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *messages(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

/** Host service secrets and alternate billing/routing variables never reach agent subprocesses. */
const inheritedEnvironment = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export const claudeCredentialPaths = () => [
  path.resolve(
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
    ".credentials.json",
  ),
  path.resolve(
    process.env.CODEX_HOME || path.join(homedir(), ".codex"),
    "auth.json",
  ),
];

export function claudeEnvironment() {
  const env: Record<string, string | undefined> = Object.fromEntries(
    inheritedEnvironment.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "fieldwork/1.0";
  env.DISABLE_AUTOUPDATER = "1";
  env.MAX_MCP_OUTPUT_TOKENS = String(maxContextSourceTokens);
  return env;
}

/** Settings every Fieldwork session shares: no user/project settings, skills, plugins or other MCP servers. */
export const isolatedSessionOptions = {
  settingSources: [],
  strictMcpConfig: true,
  skills: [],
  verbatimPrompts: true,
  extraArgs: { restricted: null, "disable-slash-commands": null },
} satisfies Partial<Options>;

export type ClaudeAccount = {
  account: AccountInfo;
  models: ModelInfo[];
  version: string | null;
};

/** Read sign-in and model availability without sending a prompt. */
export async function probeClaudeAccount(
  query: ClaudeQuery,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<ClaudeAccount> {
  const idle = new ClaudeInput();
  let session: Query | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    session = query({
      prompt: idle.messages(),
      options: {
        ...isolatedSessionOptions,
        cwd,
        env,
        tools: [],
        persistSession: false,
        permissionMode: "dontAsk",
      },
    });
    const probe = session;
    const read = (async () => {
      const init = await probe.initializationResult();
      return {
        account: await probe.accountInfo(),
        models: await probe.supportedModels(),
        version:
          typeof init.claude_code_version === "string"
            ? init.claude_code_version
            : null,
      };
    })();
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code did not start in time.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    idle.close();
    session?.close();
  }
}

/** Whether the account uses a Claude subscription sign-in rather than an API key or another provider. */
export function signedInReason(account: AccountInfo): string | null {
  if (account.apiProvider && account.apiProvider !== "firstParty")
    return "Claude Code is configured for another API provider. Fieldwork uses the Claude subscription sign-in only.";
  if (account.apiKeySource && account.apiKeySource !== "none")
    return "Claude Code is using API-key billing. Fieldwork uses the Claude subscription sign-in only.";
  if (
    !account.subscriptionType &&
    (!account.tokenSource || account.tokenSource === "none")
  )
    return "Claude Code is not signed in for Fieldwork. See platform/docs/claude-code.md for the sign-in steps.";
  return null;
}
