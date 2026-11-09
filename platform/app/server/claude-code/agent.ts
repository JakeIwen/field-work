import { tunables, type TunableKey } from "../../shared/tunables.js";
import type { ModelSelection } from "../../shared/model-selection.js";
import type { LiveTurnActivity } from "../../shared/task-activity.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  getSessionMessages,
  query as sdkQuery,
  type EffortLevel,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_EFFORT,
  type ModelRequestType,
} from "../../shared/codex-models.js";
import { publicCodexValue } from "../codex.js";
import { readCodexThreadReply } from "../codex-protocol.js";
import type {
  CodexSelectionPreferences,
  CodexStartRequest,
} from "../codex-selection.js";
import { ClaudeApprovals } from "./approvals.js";
import {
  ClaudeModelCatalog,
  isClaudeModel,
  type ClaudeSelection,
} from "./models.js";
import {
  claudeEnvironment,
  claudeCredentialPaths,
  isolatedSessionOptions,
  probeClaudeAccount,
  signedInReason,
  type ClaudeQuery,
} from "./session.js";
import {
  addTokenUsage,
  ClaudeThreadRegistry,
  claudeThreadView,
  epochSeconds,
  type AgentMessageItem,
  type ClaudeThread,
  type TranscriptEntry,
  type TurnOutcome,
} from "./threads.js";
import {
  CLAUDE_TOOL_SERVER,
  claudeSessionPolicy,
  claudeToolServer,
} from "./tools.js";
import { ClaudeLiveTurn } from "./turn.js";

type Event = Record<string, unknown>;
export type ClaudeAdapterOptions = CodexSelectionPreferences & {
  root: string;
  dataDir: string;
  onEvent: (event: Event) => void;
  contextTool?: (
    threadId: string,
    tool: string,
    args: Record<string, unknown>,
  ) => unknown;
  /** Test seams only; never accept an executable or process options from HTTP. */
  query?: ClaudeQuery;
  sessionMessages?: (
    sessionId: string,
    options: { dir: string },
  ) => Promise<TranscriptEntry[]>;
  startTimeoutMs?: number;
  tunable?: (key: TunableKey) => number;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs Fieldwork tasks in Claude Code through the Agent SDK. It mirrors the
 * Codex adapter's thread/turn surface and emits Codex-shaped events, so task
 * state, completion handlers and the UI stay provider-neutral. Each turn is a
 * separate Claude Code process that resumes the thread's saved session.
 */
export class ClaudeCodeAdapter {
  private readonly registry: ClaudeThreadRegistry;
  private readonly live = new Map<string, ClaudeLiveTurn>();
  private readonly approvals: ClaudeApprovals;
  private readonly mutating = new Set<string>();
  private readonly catalog: ClaudeModelCatalog;
  private readonly query: ClaudeQuery;
  private readonly root: string;
  private readonly dataDir: string;
  private connected = false;
  private connecting?: Promise<void>;
  private reason: string | null = "Claude Code has not connected yet.";
  private auth = "unknown";
  private version: string | null = null;

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.root = realpathSync(options.root);
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(options.dataDir);
    this.registry = new ClaudeThreadRegistry(
      path.join(this.dataDir, "claude-threads.json"),
      () => this.readTunable("models.claudeThreadTurns"),
    );
    this.query = options.query ?? sdkQuery;
    this.catalog = new ClaudeModelCatalog(
      async () => (await this.probe()).models,
      (key) => this.readTunable(key),
    );
    this.approvals = new ClaudeApprovals((threadId, event) =>
      this.emit(this.registry.get(threadId), event),
    );
  }

  private readTunable(key: TunableKey) {
    return this.options.tunable?.(key) ?? tunables[key].default;
  }

  owns(threadId: string | undefined | null) {
    return this.registry.owns(threadId);
  }
  status() {
    return {
      provider: "claude" as const,
      connected: this.connected,
      available: this.connected && this.catalog.available && !this.reason,
      connection: this.connected
        ? "connected"
        : this.connecting
          ? "connecting"
          : "disconnected",
      reason: this.reason,
      auth: this.auth,
      version: this.version,
      models: this.catalog.status().models,
      pendingRequests: this.approvals.requests(),
      threads: this.registry
        .list()
        .map(({ turns: _turns, usage: _usage, ...thread }) => thread),
    };
  }
  modelCatalogStatus() {
    return this.catalog.status();
  }

  private emit(thread: ClaudeThread | undefined, event: Event) {
    try {
      this.options.onEvent(
        publicCodexValue({
          timestamp: new Date().toISOString(),
          ...event,
          ...(thread
            ? { selection: { model: thread.model, effort: thread.effort } }
            : {}),
        }),
      );
    } catch {
      /* Subscriber errors must not kill an active turn. */
    }
  }
  /** Same draft-directory rule as Codex: inside application data, never the repository root. */
  private cwdFor(cwd: string) {
    const real = realpathSync(cwd);
    const inside = (base: string) => {
      const rel = path.relative(base, real);
      return (
        !!rel &&
        rel !== ".." &&
        !rel.startsWith(".." + path.sep) &&
        !path.isAbsolute(rel)
      );
    };
    if (!inside(this.root) || !inside(this.dataDir))
      throw new Error(
        "Agent cwd must be a draft inside application data storage. Source masters cannot be writable.",
      );
    return real;
  }
  private async probe() {
    const result = await probeClaudeAccount(
      this.query,
      this.dataDir,
      claudeEnvironment(),
      this.options.startTimeoutMs ??
        this.readTunable("models.claudeTurnStartS") * 1000,
    );
    this.version = result.version;
    const reason = signedInReason(result.account);
    this.auth = reason
      ? "signed_out"
      : (result.account.subscriptionType ?? "signed_in");
    if (reason) throw new Error(reason);
    return result;
  }

  /** Probe sign-in and models; between probes this is cached (15 minutes, or 1 minute after a failure). */
  connect(refresh = false): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!refresh && !this.catalog.refreshDue) return Promise.resolve();
    this.connecting = this.catalog
      .refresh(true)
      .then(() => {
        this.connected = true;
        this.reason = null;
      })
      .catch((error) => {
        this.connected = false;
        this.reason = String(publicCodexValue(message(error)));
        this.catalog.fail(this.reason);
      })
      .finally(() => {
        this.connecting = undefined;
        this.emit(undefined, { method: "adapter/status", ...this.status() });
      });
    return this.connecting;
  }
  warmModels() {
    return this.catalog.refreshDue ? this.connect() : Promise.resolve();
  }
  private async ready() {
    await this.connect();
    if (!this.status().available)
      throw new Error(
        this.reason ||
          "Claude Code is unavailable. Export the editable task handoff.",
      );
  }

  /**
   * Resolve a model for a Claude thread. A conversation stays with Claude
   * Code: when the saved choice names another provider, the thread keeps its
   * own model and effort.
   */
  selectionFor(
    requestType?: ModelRequestType,
    threadId?: string,
    override?: string,
    effortOverride?: string,
  ): ClaudeSelection {
    const thread = threadId ? this.registry.get(threadId) : undefined;
    const preferred =
      override ?? this.options.modelPreference?.(requestType, threadId);
    if (isClaudeModel(preferred))
      return this.catalog.resolve(
        preferred!,
        effortOverride ??
          this.options.effortPreference?.(requestType, threadId) ??
          DEFAULT_EFFORT,
      );
    if (!thread)
      throw new Error(
        "Choose a Claude Code model in Settings before starting this request.",
      );
    return this.catalog.resolve(thread.model, thread.effort);
  }
  private applySelection(thread: ClaudeThread, override?: ModelSelection) {
    const selection = this.selectionFor(
      thread.requestType,
      thread.id,
      override?.model ?? thread.modelOverride,
      override?.effort ?? thread.effortOverride,
    );
    thread.model = selection.model;
    thread.effort = selection.effort;
    thread.runtimeModel = selection.runtimeModel;
  }

  async start(input: CodexStartRequest) {
    const cwd = this.cwdFor(input.cwd || this.root);
    this.validatePrompt(input.prompt);
    await this.ready();
    const selection = this.selectionFor(
      input.requestType,
      undefined,
      input.model,
      input.effort,
    );
    const thread: ClaudeThread = {
      id: randomUUID(),
      provider: "claude",
      cwd: path.relative(this.root, cwd),
      model: selection.model,
      effort: selection.effort,
      runtimeModel: selection.runtimeModel,
      sessionStarted: false,
      turns: [],
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.requestType ? { requestType: input.requestType } : {}),
      ...(input.model && !input.transientModel
        ? { modelOverride: input.model }
        : {}),
      ...(input.effort && !input.transientModel
        ? { effortOverride: input.effort }
        : {}),
      createdAt: new Date().toISOString(),
    };
    this.registry.add(thread);
    input.onThreadCreated?.(thread.id);
    const view = claudeThreadView(this.root, thread, []);
    this.emit(thread, {
      method: "adapter/threadCreated",
      threadId: thread.id,
      params: { thread: view, model: thread.model, effort: thread.effort },
    });
    const turn = await this.send(
      thread.id,
      input.prompt,
      input.transientModel ? selection : undefined,
    );
    return { threadId: thread.id, thread: publicCodexValue(view), ...turn };
  }

  private validatePrompt(prompt: string) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 200000)
      throw new Error(
        "A nonempty prompt of at most 200,000 characters is required.",
      );
  }
  private async mutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.mutating.has(id))
      throw new Error("A thread operation is already in progress.");
    this.mutating.add(id);
    try {
      return await action();
    } finally {
      this.mutating.delete(id);
    }
  }

  async send(threadId: string, prompt: string, override?: ModelSelection) {
    this.registry.own(threadId);
    this.validatePrompt(prompt);
    await this.ready();
    return this.mutation(threadId, async () => {
      const thread = this.registry.own(threadId);
      if (this.live.has(threadId))
        throw new Error(
          "This thread already has an active turn. Use steer or interrupt.",
        );
      this.registry.abandonTurn(thread);
      this.applySelection(thread, override);
      return this.runTurn(thread, prompt);
    });
  }

  private async runTurn(thread: ClaudeThread, prompt: string) {
    const turnId = randomUUID();
    const turn = new ClaudeLiveTurn(
      turnId,
      claudeSessionPolicy(thread.purpose),
      this.cwdFor(path.resolve(this.root, thread.cwd)),
      thread.runtimeModel,
      {
        emit: (method, params) =>
          this.emit(thread, {
            method,
            threadId: thread.id,
            turnId,
            params: { threadId: thread.id, turnId, ...params },
          }),
        started: () => {
          thread.sessionStarted = true;
          thread.uncertain = false;
          this.registry.persist();
        },
        usage: (usage) => {
          const tokenUsage = addTokenUsage(thread.usage, usage);
          thread.usage = tokenUsage.total;
          this.emit(thread, {
            method: "thread/tokenUsage/updated",
            threadId: thread.id,
            turnId,
            params: { threadId: thread.id, turnId, tokenUsage },
          });
        },
        finished: (outcome, items, announce) =>
          this.turnFinished(thread, turnId, outcome, items, announce),
      },
      () => this.readTunable("models.claudeCloseGraceS") * 1000,
    );
    turn.input.push(turnId, prompt);
    turn.session = this.query({
      prompt: turn.input.messages(),
      options: this.sessionOptions(thread, turn),
    });
    this.live.set(thread.id, turn);
    this.registry.beginTurn(thread, turnId);
    void turn.consume();
    await turn.started(
      this.options.startTimeoutMs ??
        this.readTunable("models.claudeTurnStartS") * 1000,
    );
    return { turnId, turn: { id: turnId, status: "inProgress" } };
  }

  private sessionOptions(thread: ClaudeThread, turn: ClaudeLiveTurn): Options {
    const policy = turn.policy;
    return {
      ...isolatedSessionOptions,
      cwd: turn.cwd,
      model: thread.runtimeModel,
      effort: thread.effort as EffortLevel,
      ...(thread.sessionStarted
        ? { resume: thread.id }
        : { sessionId: thread.id }),
      tools: policy.tools,
      allowedTools: policy.allowedTools,
      permissionMode: policy.permissionMode,
      ...(policy.approvals
        ? {
            canUseTool: this.approvals.handler(
              thread.id,
              turn.id,
              policy.autoApprove,
            ),
          }
        : { permissionPrompts: "none" as const }),
      ...(policy.sandbox ? { sandbox: policy.sandbox } : {}),
      settings: {
        permissions: {
          deny: claudeCredentialPaths().map((file) => `Read(/${file})`),
        },
      },
      mcpServers: policy.dynamicTools.length
        ? {
            [CLAUDE_TOOL_SERVER]: claudeToolServer(
              policy.dynamicTools,
              (tool, args) => this.callTool(thread, turn, tool, args),
            ),
          }
        : {},
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: policy.instructions,
      },
      env: claudeEnvironment(),
      abortController: turn.abort,
      stderr: (data) => turn.appendStderr(data),
    };
  }

  private turnFinished(
    thread: ClaudeThread,
    turnId: string,
    outcome: TurnOutcome,
    items: AgentMessageItem[],
    announce: boolean,
  ) {
    if (this.live.get(thread.id)?.id === turnId) this.live.delete(thread.id);
    this.approvals.deny(
      thread.id,
      "The turn ended before this request was answered.",
    );
    const completedAt = this.registry.endTurn(thread, turnId, outcome);
    if (announce || outcome.status !== "failed")
      this.emit(thread, {
        method: "turn/completed",
        threadId: thread.id,
        turnId,
        params: {
          threadId: thread.id,
          turn: {
            id: turnId,
            status: outcome.status,
            items,
            error: outcome.error ? { message: outcome.error } : null,
            completedAt: epochSeconds(completedAt),
          },
        },
      });
  }

  private async callTool(
    thread: ClaudeThread,
    turn: ClaudeLiveTurn,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const event = (params: Event) =>
      this.emit(thread, {
        method: "adapter/contextTool",
        threadId: thread.id,
        turnId: turn.id,
        params: { tool, path: args?.path, ...params },
      });
    try {
      if (
        this.live.get(thread.id) !== turn ||
        thread.activeTurnId !== turn.id ||
        !turn.verified ||
        turn.interrupted ||
        turn.finished
      )
        throw new Error("This Claude Code turn is no longer active.");
      if (!this.options.contextTool)
        throw new Error("This task has no Fieldwork tools.");
      const result = await this.options.contextTool(thread.id, tool, args);
      event({ success: true });
      turn.activity.toolResultReturned();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      event({ success: false, error: message(error) });
      turn.activity.toolResultReturned();
      return {
        isError: true,
        content: [{ type: "text", text: message(error) }],
      };
    }
  }

  /** The live turn's in-memory view; undefined when no turn is running or nothing has arrived yet. */
  liveActivity(threadId: string): LiveTurnActivity | undefined {
    return this.live.get(threadId)?.activity.snapshot();
  }

  respond(requestId: string | number, response: unknown) {
    return this.approvals.respond(requestId, response);
  }
  hasRequest(requestId: string | number) {
    return this.approvals.has(String(requestId));
  }

  async steer(threadId: string, prompt: string) {
    this.validatePrompt(prompt);
    const thread = this.registry.own(threadId);
    const turn = this.live.get(threadId);
    if (!turn)
      throw new Error(
        "There is no active turn to steer. Send a follow-up message instead.",
      );
    const id = randomUUID();
    turn.steer(id, prompt);
    thread.turns.find((record) => record.id === turn.id)?.promptIds.push(id);
    this.registry.persist();
    return { turnId: turn.id };
  }

  async interrupt(threadId: string) {
    const thread = this.registry.own(threadId);
    const turn = this.live.get(threadId);
    if (!turn) {
      const turnId = thread.activeTurnId;
      if (!turnId) return { interrupted: false, reason: "No active turn." };
      this.registry.abandonTurn(thread);
      return { interrupted: true, turnId };
    }
    this.approvals.deny(threadId, "The user interrupted this turn.");
    await turn.interrupt();
    return { interrupted: true, turnId: turn.id };
  }

  async resume(threadId: string, override?: ModelSelection) {
    this.registry.own(threadId);
    await this.ready();
    return this.mutation(threadId, async () => {
      const thread = this.registry.own(threadId);
      // Resuming a running turn must not relabel or switch that turn's model.
      if (!this.live.has(threadId)) {
        this.registry.abandonTurn(thread);
        this.applySelection(thread, override);
        this.registry.persist();
      }
      const detail = await this.read(threadId);
      this.emit(thread, {
        method: "adapter/threadResumed",
        threadId,
        params: {
          thread: detail.thread,
          model: thread.model,
          effort: thread.effort,
        },
      });
      return detail;
    });
  }

  async read(threadId: string) {
    const thread = this.registry.own(threadId);
    const cwd = this.cwdFor(path.resolve(this.root, thread.cwd));
    let transcript: TranscriptEntry[] = [];
    if (thread.sessionStarted)
      try {
        transcript = await (this.options.sessionMessages ?? getSessionMessages)(
          threadId,
          { dir: cwd },
        );
      } catch {
        /* A missing transcript still leaves the recorded turns readable. */
      }
    return readCodexThreadReply(
      publicCodexValue({
        thread: claudeThreadView(this.root, thread, transcript),
      }),
    );
  }

  close() {
    for (const turn of [...this.live.values()]) {
      turn.interrupted = true;
      turn.abort.abort();
      turn.finish({
        status: "interrupted",
        error:
          "Application stopped. Saved conversations can be resumed; turns are never restarted automatically.",
      });
    }
    this.connected = false;
  }
}
