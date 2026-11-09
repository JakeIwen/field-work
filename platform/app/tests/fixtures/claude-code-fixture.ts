import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AccountInfo,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAdapter } from "../../server/claude-code/agent.js";
import type { ClaudeQuery } from "../../server/claude-code/session.js";
import type { TranscriptEntry } from "../../server/claude-code/threads.js";

type FixtureMessage = Record<string, unknown>;
export type FakeSession = {
  options: Options;
  /** Prompts this process received, in order. */
  prompts: SDKUserMessage[];
  emit: (message: FixtureMessage) => void;
  /** End the message stream; with an error, the process "exits" with it. */
  end: (error?: Error) => void;
  interrupted: boolean;
  closed: boolean;
};
export type Reply = (
  prompt: SDKUserMessage,
  session: FakeSession,
) => void | Promise<void>;

const models: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default",
    description: "Opus 5.5",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1[1m]",
    displayName: "Fable",
    description: "Fable 5.1",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5[1m]",
    displayName: "Sonnet",
    description: "Sonnet 5.5",
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

export function initMessage(
  session: FakeSession,
  overrides: FixtureMessage = {},
): FixtureMessage {
  const options = session.options;
  const mcp = Object.keys(options.mcpServers ?? {});
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.296",
    cwd: options.cwd,
    tools: [
      ...((options.tools as string[]) ?? []),
      ...(options.allowedTools ?? []).filter((tool) =>
        tool.startsWith("mcp__"),
      ),
    ],
    mcp_servers: mcp.map((name) => ({
      name,
      status: "connected",
      source: "sdk",
    })),
    model: options.model,
    permissionMode: options.permissionMode,
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "init",
    session_id: options.sessionId ?? options.resume,
    ...overrides,
  };
}
export const assistantText = (uuid: string, text: string): FixtureMessage => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: null,
  session_id: "s",
  message: {
    id: `msg-${uuid}`,
    model: "claude-opus-5-5",
    role: "assistant",
    content: [{ type: "text", text }],
  },
});
/** A raw `stream_event` as the SDK sends it with includePartialMessages, e.g. a content_block_delta. */
export const streamEvent = (
  event: Record<string, unknown>,
  overrides: FixtureMessage = {},
): FixtureMessage => ({
  type: "stream_event",
  event,
  parent_tool_use_id: null,
  uuid: "stream",
  session_id: "s",
  ...overrides,
});
/** A `system` message other than init: thinking_tokens, api_retry, status. */
export const systemMessage = (
  subtype: string,
  fields: FixtureMessage = {},
): FixtureMessage => ({
  type: "system",
  subtype,
  uuid: `system-${subtype}`,
  session_id: "s",
  ...fields,
});
export const result = (
  answered: string[],
  overrides: FixtureMessage = {},
): FixtureMessage => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  stop_reason: "end_turn",
  terminal_reason: "completed",
  num_turns: 1,
  duration_ms: 1,
  duration_api_ms: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
    output_tokens_details: { thinking_tokens: 2 },
  },
  modelUsage: {},
  permission_denials: [],
  user_message_uuid: answered.at(-1),
  user_message_uuids: answered,
  uuid: `result-${answered.join("-")}`,
  session_id: "s",
  ...overrides,
});

/** Default behavior: confirm the session, answer each prompt with one message and a result. */
export const answerEachPrompt: Reply = (prompt, session) => {
  if (session.prompts.length === 1) session.emit(initMessage(session));
  session.emit(assistantText(`a-${prompt.uuid}`, `Answer to ${prompt.uuid}`));
  session.emit(result([prompt.uuid!]));
};

/** A fake of the Agent SDK's `query`: one "process" per call, driven by `reply`. */
export function fakeQuery(
  options: {
    reply?: Reply;
    account?: AccountInfo;
    models?: ModelInfo[];
    probeError?: Error;
  } = {},
) {
  const sessions: FakeSession[] = [];
  let probes = 0;
  const query = ((params: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => {
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: Error | undefined;
    const session: FakeSession = {
      options: params.options,
      prompts: [],
      interrupted: false,
      closed: false,
      emit: (message) => {
        queue.push(message as SDKMessage);
        wake?.();
      },
      end: (error) => {
        ended = true;
        failure = error;
        wake?.();
      },
    };
    const probe = params.options.persistSession === false;
    if (probe) probes++;
    else sessions.push(session);
    const messages = (async function* () {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    })();
    if (!probe)
      void (async () => {
        for await (const prompt of params.prompt) {
          session.prompts.push(prompt);
          await (options.reply ?? answerEachPrompt)(prompt, session);
        }
        // Closing input ends the process, as the real CLI does.
        session.end();
      })();
    return Object.assign(messages, {
      interrupt: async () => {
        session.interrupted = true;
        return { still_queued: [] };
      },
      close: () => {
        session.closed = true;
        session.end();
      },
      initializationResult: async () => {
        if (options.probeError) throw options.probeError;
        return { claude_code_version: "2.1.296" };
      },
      accountInfo: async () =>
        options.account ?? {
          email: "owner@example.com",
          subscriptionType: "Claude Max",
          apiProvider: "firstParty",
        },
      supportedModels: async () => options.models ?? models,
    });
  }) as unknown as ClaudeQuery;
  return { query, sessions, probes: () => probes };
}

export function claudeFixture(
  options: Parameters<typeof fakeQuery>[0] & {
    model?: string;
    effort?: string;
    contextTool?: (
      threadId: string,
      tool: string,
      args: Record<string, unknown>,
    ) => unknown;
    transcript?: TranscriptEntry[];
    dir?: string;
  } = {},
) {
  const root =
    options.dir ??
    realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-code-")));
  const dataDir = path.join(root, ".local", "job-search");
  const draft = path.join(dataDir, "drafts", "task-1");
  mkdirSync(draft, { recursive: true });
  const fake = fakeQuery(options);
  const events: Record<string, any>[] = [];
  const settings = {
    model: options.model ?? "claude-opus-5-5",
    effort: options.effort,
  };
  const adapter = new ClaudeCodeAdapter({
    root,
    dataDir,
    query: fake.query,
    startTimeoutMs: 2000,
    modelPreference: () => settings.model,
    effortPreference: () => settings.effort,
    contextTool: options.contextTool,
    sessionMessages: async () => options.transcript ?? [],
    onEvent: (event) => events.push(event),
  });
  const turnEnded = (count = 1) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("turn did not end")),
        3000,
      );
      const check = () => {
        if (
          events.filter((e) => e.method === "turn/completed").length >= count
        ) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(check, 5);
      };
      check();
    });
  return {
    root,
    dataDir,
    draft,
    adapter,
    events,
    settings,
    ...fake,
    turnEnded,
    methods: () => events.map((event) => event.method),
    cleanup: () => {
      adapter.close();
      if (!options.dir) rmSync(root, { recursive: true, force: true });
    },
  };
}
