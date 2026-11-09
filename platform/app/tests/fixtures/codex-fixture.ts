import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../../server/codex.js";
import type { ModelRequestType } from "../../shared/codex-models.js";

type FixtureEvent = Parameters<
  NonNullable<ConstructorParameters<typeof CodexAdapter>[0]["onEvent"]>
>[0];
function forwardFixtureEvent(
  events: FixtureEvent[],
  event: FixtureEvent,
  listener?: (event: FixtureEvent) => void,
) {
  events.push(event);
  listener?.(event);
}
function replyWithTurnFailure(
  message: { method: string; id: number },
  failure: string | undefined,
  stdout: PassThrough,
) {
  if (message.method !== "turn/start" || !failure) return false;
  queueMicrotask(() =>
    stdout.write(
      JSON.stringify({
        id: message.id,
        error: { code: -32000, message: failure },
      }) + "\n",
    ),
  );
  return true;
}

// This is a protocol fixture, never a substitute for the separate real Codex probe.
export function fixture(
  options: {
    modelPreference?: (
      requestType?: ModelRequestType,
      threadId?: string,
    ) => string | undefined;
    effortPreference?: (
      requestType?: ModelRequestType,
      threadId?: string,
    ) => string | undefined;
    uniqueThreadIds?: boolean;
    broaderSandbox?: boolean;
    auth?: string;
    startupError?: string;
    defaultModel?: string | null;
    defaultWithoutHigh?: boolean;
    duplicateDefaults?: boolean;
    returnedEffort?: string;
    configuredModel?: string;
    returnedModel?: string;
    turnStartError?: string;
    onEvent?: (event: FixtureEvent) => void;
    response?: (result: any) => any;
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "fieldwork-codex-test-")),
  );
  const dataDir = path.join(root, ".local");
  const draft = path.join(dataDir, "drafts", "one");
  mkdirSync(draft, { recursive: true });
  const threads: Record<string, any> = {};
  const messages: any[] = [];
  const events: any[] = [];
  let child: any;
  let nextTurn = 0;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const processChild = child;
    child.kill = () => {
      queueMicrotask(() => processChild.emit("close", 0, null));
      return true;
    };
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        messages.push(m);
        if (!m.method || m.id === undefined) continue;
        if (replyWithTurnFailure(m, options.turnStartError, child.stdout))
          continue;
        const p = m.params;
        let result: any = {};
        const responseFor = (thread: any) => {
          const result = {
            thread,
            model: options.returnedModel ?? thread.model,
            reasoningEffort: options.returnedEffort ?? thread.effort,
            cwd: thread.cwd,
            runtimeWorkspaceRoots: [thread.cwd],
            sandbox:
              thread.sandbox === "read-only"
                ? {
                    type: "readOnly",
                    networkAccess: false,
                  }
                : {
                    type: "workspaceWrite",
                    writableRoots: [options.broaderSandbox ? root : thread.cwd],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
            activePermissionProfile: thread.permissions
              ? { id: thread.permissions }
              : null,
            approvalsReviewer: "user",
            approvalPolicy: "on-request",
          };
          return options.response ? options.response(result) : result;
        };
        if (m.method === "initialize")
          result = { userAgent: "codex-cli protocol fixture" };
        if (m.method === "account/read")
          result = {
            account: {
              type: options.auth || "chatgpt",
              email: "do-not-store@example.test",
            },
            requiresOpenaiAuth: true,
          };
        if (m.method === "config/read")
          result = {
            config: {
              model: options.configuredModel ?? "gpt-6-astra",
              model_reasoning_effort: "ultra",
              secret: "do not expose",
            },
          };
        if (m.method === "model/list")
          result = {
            data: [
              {
                id: "fixture-id",
                model: "gpt-6-astra",
                displayName: "Fixture Astra",
                supportedReasoningEfforts: [
                  ...(options.defaultWithoutHigh
                    ? []
                    : [{ reasoningEffort: "high" }]),
                  { reasoningEffort: "ultra" },
                  { reasoningEffort: "xhigh" },
                  { reasoningEffort: "max" },
                ],
                defaultReasoningEffort: "high",
                isDefault:
                  (options.defaultModel === undefined
                    ? "gpt-6-astra"
                    : options.defaultModel) === "gpt-6-astra",
              },
              {
                id: "fixture-other-id",
                model: "gpt-6-sol",
                displayName: "Fixture alternative",
                supportedReasoningEfforts: options.defaultWithoutHigh
                  ? []
                  : [{ reasoningEffort: "high" }],
                defaultReasoningEffort: "high",
                isDefault:
                  options.defaultModel === "gpt-6-sol" ||
                  !!options.duplicateDefaults,
              },
            ],
            nextCursor: null,
          };
        if (m.method === "thread/start") {
          const thread = {
            id: options.uniqueThreadIds
              ? `fixture-thread-${Object.keys(threads).length + 1}`
              : "fixture-thread",
            cwd: p.cwd,
            turns: [],
            model: p.model,
            effort: p.config.model_reasoning_effort,
            permissions: p.permissions,
            sandbox: p.sandbox,
          };
          threads[thread.id] = thread;
          result = responseFor(thread);
        }
        if (m.method === "thread/resume") {
          threads[p.threadId].model = p.model;
          threads[p.threadId].effort = p.config.model_reasoning_effort;
          result = responseFor(threads[p.threadId]);
        }
        if (m.method === "thread/read")
          result = { thread: threads[p.threadId] };
        if (m.method === "turn/start") {
          const turn = {
            id: "fixture-turn-" + ++nextTurn,
            status: "inProgress",
            items: [],
          };
          threads[p.threadId].turns.push(turn);
          result = { turn };
        }
        if (m.method === "turn/interrupt") {
          const turn = threads[p.threadId].turns.find(
            (t: any) => t.id === p.turnId,
          );
          turn.status = "interrupted";
          queueMicrotask(() =>
            notify("turn/completed", { threadId: p.threadId, turn }),
          );
        }
        queueMicrotask(() =>
          child.stdout.write(JSON.stringify({ id: m.id, result }) + "\n"),
        );
      }
    });
    if (options.startupError)
      queueMicrotask(() => {
        child.stderr.write(options.startupError);
        child.emit("close", 1, null);
      });
    return child;
  };
  const notify = (method: string, params: any, id?: number) =>
    child.stdout.write(
      JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) +
        "\n",
    );
  const create = () =>
    new CodexAdapter({
      root,
      dataDir,
      spawnProcess,
      inspectControllerProcess: () => ({
        state: "alive",
        identity: { startedAt: "2026-01-01T00:00:00Z", uid: 501 },
      }),
      modelPreference: options.modelPreference,
      effortPreference: options.effortPreference,
      requestTimeoutMs: 1000,
      onEvent: (e) => forwardFixtureEvent(events, e, options.onEvent),
    });
  const adapter = create();
  return {
    root,
    dataDir,
    draft,
    adapter,
    spawnProcess,
    create,
    messages,
    events,
    threads,
    notify,
    disconnect: () => child.emit("close", 1, null),
    cleanup: () => {
      adapter.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
