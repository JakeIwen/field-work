import { tunables, type TunableKey } from "../shared/tunables.js";
import type { ModelSelection } from "../shared/model-selection.js";
import {
  resolveCodexSelection,
  type ManagedThread,
  type CodexSelectionPreferences,
  type CodexStartRequest,
} from "./codex-selection.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexControllerLock } from "./codex-controller-lock.js";
import type { InspectControllerProcess } from "./controller-process.js";
import {
  purposeDynamicTools,
  taskThreadOptions,
  type TaskPurpose,
} from "./task-kinds/purpose-policies.js";

import {
  DEFAULT_EFFORT,
  type ModelRequestType,
} from "../shared/codex-models.js";
import { CodexLiveActivityTracker } from "./codex-live-activity.js";
import { CodexModelCatalog, MODEL_UNAVAILABLE } from "./codex-model-catalog.js";
export { DEFAULT_EFFORT } from "../shared/codex-models.js";
export const MODEL_POLICY = "codex-default";

import {
  EVENT_METHODS,
  REQUEST_METHODS,
  codexRecord,
  codexProperty,
  codexErrorMessage,
  codexRpcError,
  publicCodexErrorMessage,
  codexToolContent,
  codexQuestionIds,
  isCodexAnswer,
  readCodexMessage,
  readCodexInitialize,
  readCodexAccount,
  readCodexConfig,
  readCodexThreadReply,
  readCodexReferenceReply,
  readCodexTurnReply,
  readCodexEvent,
  publicCodexValue,
  type CodexRecord as Json,
  type CodexMessage,
  type CodexRequest,
  type CodexEvent,
  type CodexStatus,
} from "./codex-protocol.js";
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type Options = CodexSelectionPreferences & {
  root: string;
  dataDir: string;
  onEvent: (event: CodexEvent) => void;
  /** Test seam only; never accept a executable or process options from HTTP. */
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
  tunable?: (key: TunableKey) => number;
  /** Process metadata probe for controller-lock tests; never accepted from HTTP. */
  inspectControllerProcess?: InspectControllerProcess;
  referenceThreadIds?: string[];
  contextTool?: (threadId: string, tool: string, args: unknown) => unknown;
};

export { publicCodexValue } from "./codex-protocol.js";

export class CodexAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private connecting?: Promise<CodexStatus>;
  private pending = new Map<string, Pending>();
  private requests = new Map<string, CodexRequest>();
  private managed: Record<string, ManagedThread> = {};
  private loaded = new Set<string>();
  private mutating = new Set<string>();
  private sequence = 0;
  private stderr = "";
  private readonly controllerLock: CodexControllerLock;
  private connected = false;
  private reason: string | null | undefined = "Codex has not connected yet.";
  private auth = "unknown";
  private readonly catalog = new CodexModelCatalog(
    (cursor) =>
      this.rpc("model/list", {
        includeHidden: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    (key) => this.options.tunable?.(key) ?? tunables[key].default,
  );
  private mcpNames: string[] = [];
  private readonly liveTurns = new CodexLiveActivityTracker();

  private version: string | null = null;
  private readonly root: string;
  private readonly dataDir: string;
  private readonly registryPath: string;

  constructor(private readonly options: Options) {
    this.root = realpathSync(options.root);
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = realpathSync(options.dataDir);
    this.registryPath = path.join(this.dataDir, "codex-threads.json");
    this.controllerLock = new CodexControllerLock(this.dataDir, {
      inspect: options.inspectControllerProcess,
    });
    if (existsSync(this.registryPath)) {
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
      if (
        parsed.schemaVersion !== 1 ||
        !parsed.threads ||
        typeof parsed.threads !== "object"
      )
        throw new Error(
          "Invalid Codex thread registry. Restore it from your personal-data backup.",
        );
      this.managed = parsed.threads;
    }
  }

  status(): CodexStatus {
    return {
      connected: this.connected,
      available:
        this.connected && this.auth === "chatgpt" && this.catalog.available,
      connection: this.connected
        ? "connected"
        : this.connecting
          ? "connecting"
          : "disconnected",
      reason: this.reason,
      auth: this.auth,
      version: this.version,
      models: this.catalog.status().models,
      selected: this.catalog.selected,
      modelCatalog: this.catalog.status(),
      selectionPolicy: MODEL_POLICY,
      defaultEffort: DEFAULT_EFFORT,
      transport: "stdio",
      pendingRequests: [...this.requests.values()].map((request) =>
        publicCodexValue(request),
      ),
      threads: Object.values(this.managed).map((t) => ({
        ...t,
        cwd: path.relative(this.root, path.resolve(this.root, t.cwd)) || ".",
      })),
      capabilities: {
        discovery: "app-created threads only",
        resume: true,
        steer: true,
        interrupt: true,
        approvals: true,
        userInput: true,
        hiddenReasoning: false,
      },
    };
  }

  /** The live turn's in-memory view; see codex-live-activity.ts. */
  liveActivity(threadId: string) {
    return this.liveTurns.snapshot(threadId);
  }
  private emit(event: Json) {
    try {
      this.options.onEvent(
        readCodexEvent(
          publicCodexValue({ timestamp: new Date().toISOString(), ...event }),
        ),
      );
    } catch {
      /* Subscriber errors must not kill an active turn. */
    }
  }
  private persist() {
    const temp = `${this.registryPath}.${randomUUID()}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ schemaVersion: 1, threads: this.managed }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    renameSync(temp, this.registryPath);
  }
  private acquireLock() {
    if (this.controllerLock.owned) return;
    this.controllerLock.acquire();
    // Reload after exclusive ownership so a completed process cannot leave stale records.
    if (existsSync(this.registryPath))
      this.managed = JSON.parse(
        readFileSync(this.registryPath, "utf8"),
      ).threads;
  }
  private releaseLock() {
    this.controllerLock.release();
  }
  private write(message: Json) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error(this.reason || "Codex is disconnected.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  private rpc(method: string, params: Json = {}): Promise<unknown> {
    const id = `fieldwork-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(
              `Codex ${method} timed out. Its outcome may be unknown; resume/read the saved thread before retrying a turn.`,
            ),
          );
        },
        this.options.requestTimeoutMs ??
          (this.options.tunable?.("models.codexRequestTimeoutS") ??
            tunables["models.codexRequestTimeoutS"].default) * 1000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private disconnected(reason: string, child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = undefined;
    this.connected = false;
    this.loaded.clear();
    this.reason = publicCodexValue(reason);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(this.reason!));
    }
    this.pending.clear();
    this.requests.clear();
    // No turn survives a lost app-server, so no view of one may keep claiming "writing".
    this.liveTurns.clearAll();
    for (const thread of Object.values(this.managed)) {
      if (thread.activeTurnId) {
        thread.uncertain = true;
        this.emit({
          method: "adapter/disconnected",
          threadId: thread.id,
          turnId: thread.activeTurnId,
          status: "disconnected",
          reason: this.reason,
        });
      }
    }
    if (this.controllerLock.owned) this.persist();
    this.releaseLock();
    this.emit({ method: "adapter/status", ...this.status() });
  }
  private receive(line: string) {
    let message: CodexMessage;
    try {
      message = readCodexMessage(JSON.parse(line));
    } catch {
      this.emit({
        method: "adapter/warning",
        message: "Ignored an invalid app-server protocol line.",
      });
      return;
    }
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(String(message.id));
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(String(message.id));
      if (message.error) p.reject(codexRpcError(message.error));
      else p.resolve(message.result);
      return;
    }
    const { method, params } = message;
    const threadId = params.threadId || params.thread.id;
    const thread = threadId ? this.managed[threadId] : undefined;
    this.liveTurns.observeMessage(message);
    if (message.id !== undefined) {
      if (
        method === "item/tool/call" &&
        threadId !== undefined &&
        params.tool !== undefined &&
        thread?.purpose &&
        this.options.contextTool
      ) {
        const requestId = message.id;
        const tool = params.tool;
        void Promise.resolve()
          .then(() =>
            this.options.contextTool!(threadId, tool, params.arguments),
          )
          .then((result) => {
            this.write({
              id: requestId,
              result: {
                success: true,
                contentItems: codexToolContent(result),
              },
            });
            this.emit({
              method: "adapter/contextTool",
              threadId,
              turnId: params.turnId,
              params: {
                tool: params.tool,
                path: codexProperty(params.arguments, "path"),
                success: true,
              },
            });
          })
          .catch((error: unknown) => {
            const message = codexProperty(error, "message");
            this.write({
              id: requestId,
              result: {
                success: false,
                contentItems: [{ type: "inputText", text: message }],
              },
            });
            this.emit({
              method: "adapter/contextTool",
              threadId,
              turnId: params.turnId,
              params: {
                tool: params.tool,
                path: codexProperty(params.arguments, "path"),
                success: false,
                error: message,
              },
            });
          });
        return;
      }
      if (
        !method ||
        !REQUEST_METHODS.has(method) ||
        !threadId ||
        !this.managed[threadId]
      ) {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message:
              "This local client does not support that request or thread. No action was approved.",
          },
        });
        this.emit({
          method: "adapter/unsupportedRequest",
          threadId: thread ? threadId : undefined,
          requestMethod: method,
          message: "Unsupported request rejected without approving it.",
        });
        return;
      }
      const request: CodexRequest = {
        id: message.id,
        requestId: String(message.id),
        method,
        threadId,
        turnId: params.turnId,
        params: params.raw,
      };
      this.requests.set(String(message.id), request);
      this.emit({
        method: "adapter/request",
        threadId,
        turnId: params.turnId,
        request,
        status:
          method.includes("Input") || method.includes("elicitation")
            ? "waiting_input"
            : "waiting_approval",
      });
      return;
    }
    if (method === "account/updated") {
      this.auth =
        params.authMode === "chatgpt"
          ? "chatgpt"
          : params.authMode || "signed_out";
      this.reason =
        this.auth === "chatgpt"
          ? this.catalog.available
            ? null
            : MODEL_UNAVAILABLE
          : "Existing managed ChatGPT sign-in is required; API-key billing is disabled in this application.";
      this.emit({ method: "adapter/status", ...this.status() });
      return;
    }
    if (!method || !EVENT_METHODS.has(method) || (threadId && !thread)) return;
    if (params.item?.type === "reasoning") return;
    if (method === "turn/started" && thread) {
      thread.activeTurnId = params.turn.id;
      thread.uncertain = false;
      this.persist();
    }
    if (method === "turn/completed" && thread) {
      delete thread.activeTurnId;
      thread.uncertain = false;
      for (const [id, request] of this.requests)
        if (request.threadId === threadId) this.requests.delete(id);
      this.persist();
    }
    if (method === "serverRequest/resolved")
      this.requests.delete(String(params.requestId));
    this.emit({
      method,
      threadId,
      turnId: params.turnId || params.turn?.id,
      params: params.raw,
      ...(thread
        ? {
            selection: {
              model: thread.model,
              effort: thread.effort,
            },
          }
        : {}),
    });
  }

  async connect(refresh = false) {
    if (this.connected) {
      if (refresh) await this.refreshSelection();
      return this.status();
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async doConnect() {
    try {
      this.acquireLock();
      this.stderr = "";
      this.reason = "Connecting to the installed Codex CLI.";
      const env = { ...process.env };
      for (const key of [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "AZURE_OPENAI_API_KEY",
      ])
        delete env[key];
      const child =
        this.options.spawnProcess?.() ??
        spawn(
          "codex",
          [
            "app-server",
            "--stdio",
            "-c",
            "analytics.enabled=false",
            "-c",
            'model_provider="openai"',
            "-c",
            'model_reasoning_effort="high"',
          ],
          { cwd: this.root, env, stdio: ["pipe", "pipe", "pipe"] },
        );
      this.child = child;
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      lines.on("line", (line) => {
        try {
          this.receive(line);
        } catch (e) {
          this.emit({ method: "adapter/error", message: codexErrorMessage(e) });
        }
      });
      child.stderr.on("data", (chunk) => {
        this.stderr = publicCodexValue(
          (this.stderr + chunk.toString()).slice(-6000),
        );
      });
      child.stdin.on("error", () => {});
      child.on("error", (error) =>
        this.disconnected(`Unable to start Codex: ${error.message}`, child),
      );
      child.on("close", (code, signal) => {
        lines.close();
        this.disconnected(
          `Codex app-server exited (${signal || code}). ${this.stderr.trim() || "No diagnostic was supplied."}`,
          child,
        );
      });
      const init = await this.rpc("initialize", {
        clientInfo: {
          name: "jri_job_search",
          title: "Local Job Search",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.version = readCodexInitialize(init);
      this.write({ method: "initialized", params: {} });
      const [account, config] = await Promise.all([
        this.rpc("account/read", { refreshToken: false }),
        this.rpc("config/read", { cwd: this.root, includeLayers: false }),
      ]);
      this.auth = readCodexAccount(account);
      this.mcpNames = readCodexConfig(config);
      await this.refreshSelection();
      this.connected = true;
      this.reason =
        this.auth !== "chatgpt"
          ? "Existing managed ChatGPT sign-in is required; API-key billing is disabled in this application."
          : !this.catalog.available
            ? MODEL_UNAVAILABLE
            : null;
      this.emit({ method: "adapter/status", ...this.status() });
    } catch (error) {
      this.reason = publicCodexErrorMessage(error);
      const child = this.child;
      this.child = undefined;
      child?.kill();
      this.connected = false;
      this.releaseLock();
      this.emit({ method: "adapter/status", ...this.status() });
    }
    return this.status();
  }
  private async refreshSelection(force = true) {
    try {
      await this.catalog.refresh(force);
      this.reason =
        this.auth !== "chatgpt"
          ? "Existing managed ChatGPT sign-in is required; API-key billing is disabled in this application."
          : this.catalog.available
            ? null
            : MODEL_UNAVAILABLE;
    } finally {
      this.emit({ method: "adapter/status", ...this.status() });
    }
  }
  warmModels() {
    return this.catalog.warm(
      () => this.connect(),
      () => this.connected,
      () => this.refreshSelection(false),
    );
  }
  modelCatalogStatus() {
    return this.catalog.status({
      connecting: !!this.connecting,
      available: this.status().available,
      reason: this.reason ?? null,
    });
  }
  selectionFor(
    requestType?: ModelRequestType,
    threadId?: string,
    override?: string,
    effortOverride?: string,
  ) {
    return resolveCodexSelection(
      this.catalog,
      this.options,
      requestType,
      threadId,
      { model: override, effort: effortOverride },
    );
  }
  private async ready(refreshSelection = false) {
    await this.connect();
    if (this.connected && refreshSelection) await this.refreshSelection();
    if (!this.status().available)
      throw new Error(
        this.reason ||
          "Codex is unavailable. Export the editable task handoff.",
      );
  }
  private cwdFor(cwd: string) {
    const real = realpathSync(cwd);
    const rel = path.relative(this.root, real);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(rel)
    )
      throw new Error(
        "Agent cwd must be an isolated draft directory inside the project, never the repository root.",
      );
    const dataRel = path.relative(this.dataDir, real);
    if (
      !dataRel ||
      dataRel === ".." ||
      dataRel.startsWith(".." + path.sep) ||
      path.isAbsolute(dataRel)
    )
      throw new Error(
        "Agent cwd must be a draft inside application data storage. Source masters cannot be writable.",
      );
    return real;
  }
  private own(id: string) {
    const thread = this.managed[id];
    if (!thread)
      throw new Error(
        "This application does not own that Codex thread. Unrelated conversations cannot be read or controlled.",
      );
    return thread;
  }
  private sandbox(cwd: string, purpose?: TaskPurpose) {
    if (purpose === "questions" || purpose === "application-answers")
      return { type: "readOnly", networkAccess: false };
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  private threadOptions(cwd: string, effort: string, purpose?: TaskPurpose) {
    return taskThreadOptions(cwd, effort, purpose, this.mcpNames);
  }
  private verifySandbox(result: Json, cwd: string, purpose?: TaskPurpose) {
    const policy = result.sandbox;
    const sandbox = codexRecord(policy);
    const sameDraft = (value: unknown) => {
      if (typeof value !== "string" || !path.isAbsolute(value)) return false;
      try {
        return realpathSync(value) === cwd;
      } catch {
        return false;
      }
    };
    const draftRoots = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every(sameDraft);
    // Codex 0.154/0.155 materializes workspace access from runtime roots and
    // may omit a redundant cwd from writableRoots. Compare effective roots,
    // not their count. Missing runtime roots cannot prove the same boundary.
    const locationVerified =
      sameDraft(result.cwd) &&
      sameDraft(codexProperty(result.thread, "cwd")) &&
      draftRoots(result.runtimeWorkspaceRoots) &&
      result.runtimeWorkspaceRoots.length > 0;
    const policyKeys = purpose
      ? ["type", "networkAccess"]
      : [
          "type",
          "writableRoots",
          "networkAccess",
          "excludeTmpdirEnvVar",
          "excludeSlashTmp",
        ];
    const policyVerified =
      policy &&
      typeof policy === "object" &&
      !Array.isArray(policy) &&
      Object.keys(policy).every((key) => policyKeys.includes(key)) &&
      sandbox.networkAccess === false &&
      (purpose
        ? sandbox.type === "readOnly"
        : sandbox.type === "workspaceWrite" &&
          sandbox.excludeTmpdirEnvVar === true &&
          sandbox.excludeSlashTmp === true &&
          draftRoots(sandbox.writableRoots));
    if (!locationVerified || !policyVerified) {
      throw new Error(
        "Codex returned a broader or unverifiable sandbox. No turn was started. Use the exported handoff and inspect installed permissions.",
      );
    }
    if (
      result.approvalsReviewer !== "user" ||
      result.approvalPolicy !== "on-request"
    )
      throw new Error(
        "Codex did not route approvals to the user. No turn was started.",
      );
  }
  private verifyModel(
    result: Json,
    selection: { model: string; effort: string },
  ) {
    if (
      result.model !== selection.model ||
      result.reasoningEffort !== selection.effort
    )
      throw new Error(
        "Codex did not confirm the selected model and reasoning effort. No turn was started.",
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
  async start(input: CodexStartRequest) {
    const cwd = this.cwdFor(input.cwd || this.root);
    this.validatePrompt(input.prompt);
    await this.ready(true);
    const selection = this.selectionFor(
      input.requestType,
      undefined,
      input.model,
      input.effort,
    );
    const effort = selection.effort;
    const result = await this.rpc("thread/start", {
      model: selection.model,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      ephemeral: false,
      historyMode: "legacy",
      ...this.threadOptions(cwd, effort, input.purpose),
      ...(input.purpose
        ? { dynamicTools: purposeDynamicTools(input.purpose) }
        : {}),
    }).then(readCodexThreadReply);
    this.verifyModel(result, selection);
    this.verifySandbox(result, cwd, input.purpose);
    const threadId = result.thread.id;
    if (!threadId)
      throw new Error("Codex did not return a thread id. No turn was started.");
    this.managed[threadId] = {
      id: threadId,
      cwd: path.relative(this.root, cwd),
      model: selection.model,
      effort,
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
    this.persist();
    this.loaded.add(threadId);
    input.onThreadCreated?.(threadId);
    this.emit({
      method: "adapter/threadCreated",
      threadId,
      params: { thread: result.thread, ...selection },
    });
    const turn = await this.send(
      threadId,
      input.prompt,
      input.transientModel ? selection : undefined,
    );
    return { threadId, thread: publicCodexValue(result.thread), ...turn };
  }
  async read(threadId: string) {
    this.own(threadId);
    await this.ready();
    const result = await this.rpc("thread/read", {
      threadId,
      includeTurns: true,
    }).then(readCodexThreadReply);
    const expected = this.cwdFor(
      path.resolve(this.root, this.own(threadId).cwd),
    );
    if (realpathSync(result.thread.cwd ?? "") !== expected)
      throw new Error(
        "Saved thread cwd changed; refusing to disclose or control it.",
      );
    return readCodexThreadReply(publicCodexValue(result));
  }
  async readReferenceThread(threadId: string) {
    if (!this.options.referenceThreadIds?.includes(threadId))
      throw new Error(
        "This reference conversation was not explicitly authorized",
      );
    await this.ready();
    return readCodexReferenceReply(
      await this.rpc("thread/read", { threadId, includeTurns: true }),
    );
  }
  async resume(threadId: string, override?: ModelSelection) {
    this.own(threadId);
    await this.ready(true);
    return this.mutation(threadId, () =>
      this.resumeInternal(threadId, override),
    );
  }
  private async resumeInternal(threadId: string, override?: ModelSelection) {
    const thread = this.own(threadId);
    const cwd = this.cwdFor(path.resolve(this.root, thread.cwd));
    // Resuming a running turn must not relabel or switch that turn's model.
    const detail = await this.rpc("thread/read", {
      threadId,
      includeTurns: true,
    }).then(readCodexThreadReply);
    const running = detail.thread.turns?.some(
      (t: Json) => t.status === "inProgress",
    );
    const selection = running
      ? { model: thread.model, effort: thread.effort }
      : (override ??
        this.selectionFor(
          thread.requestType,
          threadId,
          thread.modelOverride,
          thread.effortOverride,
        ));
    this.loaded.delete(threadId);
    const result = await this.rpc("thread/resume", {
      threadId,
      model: selection.model,
      modelProvider: "openai",
      ...this.threadOptions(cwd, selection.effort, thread.purpose),
    }).then(readCodexThreadReply);
    this.verifyModel(result, selection);
    this.verifySandbox(result, cwd, thread.purpose);
    thread.model = selection.model;
    thread.effort = selection.effort;
    this.loaded.add(threadId);
    const active = result.thread.turns?.find(
      (t: Json) => t.status === "inProgress",
    );
    if (active) thread.activeTurnId = active.id;
    else {
      delete thread.activeTurnId;
      this.liveTurns.clear(threadId);
    }
    thread.uncertain = false;
    this.persist();
    this.emit({
      method: "adapter/threadResumed",
      threadId,
      params: { thread: result.thread, ...selection },
    });
    return readCodexThreadReply(publicCodexValue(result));
  }
  private validatePrompt(prompt: string) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 200000)
      throw new Error(
        "A nonempty prompt of at most 200,000 characters is required.",
      );
  }
  async send(threadId: string, prompt: string, override?: ModelSelection) {
    this.own(threadId);
    this.validatePrompt(prompt);
    await this.ready(true);
    return this.mutation(threadId, async () => {
      if (!this.loaded.has(threadId) || this.own(threadId).uncertain)
        await this.resumeInternal(threadId, override);
      const thread = this.own(threadId);
      if (thread.activeTurnId)
        throw new Error(
          "This thread already has an active turn. Use steer or interrupt.",
        );
      const selection = this.selectionFor(
        thread.requestType,
        threadId,
        override?.model ?? thread.modelOverride,
        override?.effort ?? thread.effortOverride,
      );
      if (
        thread.model !== selection.model ||
        thread.effort !== selection.effort
      )
        await this.resumeInternal(threadId, selection);
      const cwd = this.cwdFor(path.resolve(this.root, thread.cwd));
      thread.uncertain = true;
      this.persist();
      try {
        const result = await this.rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          model: thread.model,
          effort: thread.effort,
          cwd,
          runtimeWorkspaceRoots: [cwd],
          sandboxPolicy: thread.purpose
            ? { type: "readOnly", networkAccess: false }
            : this.sandbox(cwd),
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        }).then(readCodexTurnReply);
        if (result.turn.status === "inProgress")
          thread.activeTurnId = result.turn.id;
        thread.uncertain = false;
        this.persist();
        return { turnId: result.turn.id, turn: publicCodexValue(result.turn) };
      } catch (error) {
        this.emit({
          method: "adapter/turnUncertain",
          threadId,
          message:
            "The turn request failed or disconnected. Read/resume before retrying; it was not automatically restarted.",
        });
        throw error;
      }
    });
  }
  async steer(threadId: string, prompt: string) {
    this.validatePrompt(prompt);
    const thread = this.own(threadId);
    await this.ready();
    if (!this.loaded.has(threadId)) await this.resume(threadId);
    if (!thread.activeTurnId)
      throw new Error(
        "There is no active turn to steer. Send a follow-up message instead.",
      );
    return this.rpc("turn/steer", {
      threadId,
      expectedTurnId: thread.activeTurnId,
      input: [{ type: "text", text: prompt }],
    });
  }
  async interrupt(threadId: string) {
    const thread = this.own(threadId);
    await this.ready();
    if (!this.loaded.has(threadId)) await this.resume(threadId);
    if (!thread.activeTurnId)
      return { interrupted: false, reason: "No active turn." };
    await this.rpc("turn/interrupt", { threadId, turnId: thread.activeTurnId });
    return { interrupted: true, turnId: thread.activeTurnId };
  }
  respond(requestId: string | number, response: Json) {
    const request = this.requests.get(String(requestId));
    if (!request)
      throw new Error(
        "Approval/input request no longer exists. Refresh the conversation.",
      );
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("A structured response is required.");
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(request.method)
    ) {
      if (
        !["accept", "decline", "cancel"].some(
          (value) => value === response.decision,
        ) ||
        Object.keys(response).some((k) => k !== "decision")
      )
        throw new Error(
          "Choose accept once, decline, or cancel. Session-wide approvals are not supported.",
        );
    } else if (request.method === "item/tool/requestUserInput") {
      if (!response.answers || typeof response.answers !== "object")
        throw new Error("Supply answers keyed by question ID.");
      const questionIds = codexQuestionIds(request.params);
      for (const [key, answer] of Object.entries(response.answers))
        if (!questionIds.has(key) || !isCodexAnswer(answer))
          throw new Error("Invalid question answers.");
    } else if (request.method === "mcpServer/elicitation/request") {
      if (
        !["accept", "decline", "cancel"].some(
          (value) => value === response.action,
        )
      )
        throw new Error("Invalid elicitation action.");
    } else if (request.method === "item/permissions/requestApproval") {
      // New filesystem access cannot bypass the app's isolated revision boundary.
      if (
        response.scope !== "turn" ||
        !response.permissions ||
        Object.keys(response.permissions).length
      )
        throw new Error(
          'This client can decline extra permissions with {"permissions":{},"scope":"turn"}. Extra grants require an external handoff.',
        );
    }
    this.write({ id: request.id, result: response });
    this.requests.delete(String(requestId));
    this.emit({
      method: "adapter/requestAnswered",
      threadId: request.threadId,
      requestId: String(requestId),
    });
    return { answered: true };
  }
  close() {
    const child = this.child;
    if (child) {
      this.disconnected(
        "Application stopped. Saved conversations can be resumed; turns are never restarted automatically.",
        child,
      );
      child.kill();
    } else this.releaseLock();
  }
}
