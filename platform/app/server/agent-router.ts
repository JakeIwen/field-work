import type { ModelSelection } from "../shared/model-selection.js";
import type { ModelCatalogStatus } from "../shared/codex-models.js";
import type { LiveTurnActivity } from "../shared/task-activity.js";
import { CodexAdapter } from "./codex.js";
import { readCodexEvent } from "./codex-protocol.js";
import {
  ClaudeCodeAdapter,
  type ClaudeAdapterOptions,
} from "./claude-code/agent.js";
import { isClaudeModel } from "./claude-code/models.js";
import type {
  CodexSelectionPreferences,
  CodexStartRequest,
} from "./codex-selection.js";

type RouterOptions = CodexSelectionPreferences &
  Omit<
    ConstructorParameters<typeof CodexAdapter>[0],
    "modelPreference" | "effortPreference"
  > & {
    /** Test seams only; never accept an executable or process options from HTTP. */
    claude?: Pick<
      ClaudeAdapterOptions,
      "query" | "sessionMessages" | "startTimeoutMs"
    >;
  };

/**
 * Fieldwork's single agent surface over Codex and Claude Code. New requests
 * go to the provider of their saved (or overridden) model; every later
 * operation goes to the adapter that owns the conversation, because a thread
 * never moves between providers.
 */
export class AgentRouter {
  readonly codex: CodexAdapter;
  readonly claude: ClaudeCodeAdapter;

  constructor(private readonly options: RouterOptions) {
    const codexThread = (threadId?: string) =>
      threadId
        ? this.codex.status().threads.find((thread) => thread.id === threadId)
        : undefined;
    this.codex = new CodexAdapter({
      ...options,
      // A Codex conversation keeps its own model and effort when Settings now choose Claude Code.
      modelPreference: (type, threadId) => {
        const model = options.modelPreference?.(type, threadId);
        return isClaudeModel(model) ? codexThread(threadId)?.model : model;
      },
      effortPreference: (type, threadId) =>
        isClaudeModel(options.modelPreference?.(type, threadId))
          ? codexThread(threadId)?.effort
          : options.effortPreference?.(type, threadId),
    });
    this.claude = new ClaudeCodeAdapter({
      ...options.claude,
      root: options.root,
      dataDir: options.dataDir,
      tunable: options.tunable,
      onEvent: (event) => options.onEvent(readCodexEvent(event)),
      contextTool: options.contextTool,
      modelPreference: options.modelPreference,
      effortPreference: options.effortPreference,
    });
  }

  private owner(threadId: string) {
    return this.claude.owns(threadId) ? this.claude : this.codex;
  }

  status() {
    const codex = this.codex.status();
    const claude = this.claude.status();
    return {
      ...codex,
      available: codex.available || claude.available,
      reason: codex.available || !claude.available ? codex.reason : null,
      pendingRequests: [...codex.pendingRequests, ...claude.pendingRequests],
      threads: [...codex.threads, ...claude.threads],
      providers: {
        codex: {
          connected: codex.connected,
          available: codex.available,
          reason: codex.reason,
          auth: codex.auth,
          version: codex.version,
        },
        claude: {
          connected: claude.connected,
          available: claude.available,
          reason: claude.reason,
          auth: claude.auth,
          version: claude.version,
        },
      },
    };
  }

  /** Codex connects as before; Claude Code is probed in the background unless a refresh was requested. */
  async connect(refresh = false) {
    const claude = this.claude.connect(refresh).catch(() => {});
    await this.codex.connect(refresh);
    if (refresh || !this.codex.status().available) await claude;
    return this.status();
  }
  warmModels() {
    return Promise.all([
      this.codex.warmModels(),
      this.claude.warmModels(),
    ]).then(() => undefined);
  }
  modelCatalogStatus(): ModelCatalogStatus {
    const codex = this.codex.modelCatalogStatus();
    const claude = this.claude.modelCatalogStatus();
    const claudeStatus = this.claude.status();
    const claudeError = claudeStatus.available
      ? null
      : (claude.error ?? claudeStatus.reason ?? "Claude Code is unavailable.");
    return {
      ...codex,
      models: [...codex.models, ...claude.models],
      refreshing:
        codex.refreshing ||
        claude.refreshing ||
        claudeStatus.connection === "connecting",
      ...(claudeError ? { providerErrors: { claude: claudeError } } : {}),
    };
  }

  start(input: CodexStartRequest) {
    const model =
      input.model ?? this.options.modelPreference?.(input.requestType);
    return isClaudeModel(model)
      ? this.claude.start(input)
      : this.codex.start(input);
  }
  send(threadId: string, prompt: string, selection?: ModelSelection) {
    return this.owner(threadId).send(threadId, prompt, selection);
  }
  steer(threadId: string, prompt: string) {
    return this.owner(threadId).steer(threadId, prompt);
  }
  interrupt(threadId: string) {
    return this.owner(threadId).interrupt(threadId);
  }
  read(threadId: string) {
    return this.owner(threadId).read(threadId);
  }
  resume(threadId: string, selection?: ModelSelection) {
    return this.owner(threadId).resume(threadId, selection);
  }
  respond(requestId: string | number, response: Record<string, unknown>) {
    return this.claude.hasRequest(requestId)
      ? this.claude.respond(requestId, response)
      : this.codex.respond(requestId, response);
  }
  /** In-memory view of the thread's running turn from whichever adapter owns it. */
  liveActivity(threadId: string): LiveTurnActivity | undefined {
    return this.owner(threadId).liveActivity(threadId);
  }
  readReferenceThread(threadId: string) {
    return this.codex.readReferenceThread(threadId);
  }
  close() {
    this.claude.close();
    this.codex.close();
  }
}
