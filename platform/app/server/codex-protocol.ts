import type { TaskEvent, TaskRequest } from "../shared/task-records.js";
import type { referenceFromThread } from "./question-context.js";
import type { ManagedThread } from "./codex-selection.js";
import type { ModelCatalogStatus } from "../shared/codex-models.js";
import type { ModelSelection } from "../shared/model-selection.js";

type ReferenceThread = Parameters<typeof referenceFromThread>[0];
type ReferenceItem = NonNullable<
  NonNullable<ReferenceThread["turns"]>[number]["items"]
>[number];
export type CodexEvent = Omit<TaskEvent, "params" | "threadId" | "reason"> &
  CodexRecord & {
    threadId?: string | null;
    reason?: string | null;
    timestamp?: string;
    params?: CodexRecord & {
      turn?: CodexTurn;
      threadId?: string;
      thread?: { id?: string };
      clientRequestId?: string;
    };
  };
export type CodexStatus = {
  connected: boolean;
  available: boolean;
  connection: string;
  reason: string | null | undefined;
  auth: string;
  version: string | null;
  models: ModelCatalogStatus["models"];
  selected: ModelSelection | null;
  modelCatalog: ModelCatalogStatus;
  selectionPolicy: string;
  defaultEffort: string;
  transport: string;
  pendingRequests: CodexRequest[];
  threads: ManagedThread[];
  capabilities: {
    discovery: string;
    resume: boolean;
    steer: boolean;
    interrupt: boolean;
    approvals: boolean;
    userInput: boolean;
    hiddenReasoning: boolean;
  };
};

export type CodexRecord = Record<string, unknown>;
export type CodexTurn = NonNullable<NonNullable<TaskEvent["params"]>["turn"]> &
  CodexRecord & { id: string };
export type CodexThread = CodexRecord &
  Pick<ReferenceThread, "id" | "cwd"> & { turns: CodexTurn[] };
export type CodexThreadReply = CodexRecord & { thread: CodexThread };
export type CodexTurnReply = CodexRecord & { turn: CodexTurn };
export type CodexRequest = TaskRequest & {
  id: string | number;
  threadId: string;
  turnId?: string;
  params: CodexRecord;
};
export type CodexParams = {
  raw: CodexRecord;
  threadId?: string;
  turnId?: string;
  thread: { id?: string };
  turn: NonNullable<NonNullable<TaskEvent["params"]>["turn"]>;
  item: CodexRecord;
  tool?: string;
  arguments: unknown;
  authMode?: string;
  requestId: unknown;
};
export type CodexMessage = {
  id?: string | number;
  method?: string;
  params: CodexParams;
  error: unknown;
  result: unknown;
};

export const REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
]);
export const EVENT_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "thread/tokenUsage/updated",
  "serverRequest/resolved",
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "mcpServer/startupStatus/updated",
]);

// Only consumed fields are read; new protocol fields remain in the raw payload.
// Shapes follow codex-cli 0.162.1's experimental app-server TypeScript schema.
function isCodexRecord(value: unknown): value is CodexRecord {
  return value !== null && typeof value === "object";
}
export function codexRecord(value: unknown): CodexRecord {
  return isCodexRecord(value) ? value : {};
}
export function codexString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function codexProperty(value: unknown, key: string): unknown {
  return codexRecord(value)[key];
}
export function codexErrorMessage(value: unknown): string | undefined {
  return codexString(codexProperty(value, "message"));
}
export function readCodexTurn(value: unknown): CodexTurn {
  if (isCodexTurn(value)) return value;
  const raw = codexRecord(value);
  return {
    ...raw,
    id: codexString(raw.id) ?? "",
    status: codexString(raw.status),
  };
}
function readCodexItem(value: unknown): ReferenceItem {
  if (isCodexItem(value)) return value;
  const raw = codexRecord(value);
  return {
    ...raw,
    type: codexString(raw.type) ?? "",
    text: codexString(raw.text),
    content: Array.isArray(raw.content)
      ? raw.content.map((value: unknown) => {
          const content = codexRecord(value);
          return {
            ...content,
            type: codexString(content.type) ?? "",
            text: codexString(content.text),
          };
        })
      : undefined,
  };
}
export function readCodexThread(value: unknown): CodexThread {
  if (isCodexThread(value)) return value;
  const raw = codexRecord(value);
  return {
    ...raw,
    id: codexString(raw.id) ?? "",
    cwd: codexString(raw.cwd),
    turns: Array.isArray(raw.turns) ? raw.turns.map(readCodexTurn) : [],
  };
}
export function readCodexThreadReply(value: unknown): CodexThreadReply {
  const raw = codexRecord(value);
  return { ...raw, thread: readCodexThread(raw.thread) };
}
export function readCodexTurnReply(value: unknown): CodexTurnReply {
  const raw = codexRecord(value);
  return { ...raw, turn: readCodexTurn(raw.turn) };
}
export function readCodexMessage(value: unknown): CodexMessage {
  const raw = codexRecord(value);
  const params = codexRecord(raw.params || {});
  return {
    id:
      typeof raw.id === "string" || typeof raw.id === "number"
        ? raw.id
        : undefined,
    method: codexString(raw.method),
    error: raw.error,
    result: raw.result,
    params: {
      raw: params,
      threadId: codexString(params.threadId),
      turnId: codexString(params.turnId),
      thread: { id: codexString(codexProperty(params.thread, "id")) },
      turn: {
        id: codexString(codexProperty(params.turn, "id")),
        status: codexString(codexProperty(params.turn, "status")),
      },
      item: codexRecord(params.item),
      tool: codexString(params.tool),
      arguments: params.arguments,
      authMode: codexString(params.authMode),
      requestId: params.requestId,
    },
  };
}
export function readCodexInitialize(value: unknown) {
  const raw = codexRecord(value);
  return codexString(raw.userAgent) || codexString(raw.version) || null;
}
export function readCodexAccount(value: unknown) {
  const account = codexProperty(value, "account");
  return codexString(codexProperty(account, "type")) || "signed_out";
}
export function readCodexConfig(value: unknown) {
  const servers = codexProperty(codexProperty(value, "config"), "mcp_servers");
  return Object.keys(servers ?? {});
}
export function codexQuestionIds(params: CodexRecord): Set<unknown> {
  const questions = params.questions || [];
  return new Set(
    Array.isArray(questions)
      ? questions.map((q: unknown) => codexProperty(q, "id"))
      : [],
  );
}
export function isCodexAnswer(value: unknown): value is { answers: string[] } {
  const answers = codexProperty(value, "answers");
  return (
    Array.isArray(answers) &&
    answers.every((entry: unknown) => typeof entry === "string")
  );
}

export function readCodexEvent(value: unknown): CodexEvent {
  if (isCodexEvent(value)) return value;
  const raw = codexRecord(value);
  const params = codexRecord(raw.params);
  return {
    ...raw,
    method: codexString(raw.method) ?? "",
    timestamp: codexString(raw.timestamp),
    at: codexString(raw.at),
    threadId: raw.threadId === null ? null : codexString(raw.threadId),
    turnId: codexString(raw.turnId),
    requestId: codexString(raw.requestId),
    status: codexString(raw.status),
    reason: raw.reason === null ? null : codexString(raw.reason),
    message: codexString(raw.message),
    request:
      raw.request === undefined ? undefined : readCodexRequest(raw.request),
    params:
      raw.params === undefined
        ? undefined
        : {
            ...params,
            threadId: codexString(params.threadId),
            clientRequestId: codexString(params.clientRequestId),
            thread:
              params.thread === undefined
                ? undefined
                : readCodexThread(params.thread),
            turn:
              params.turn === undefined
                ? undefined
                : readCodexTurn(params.turn),
          },
  };
}
function readCodexRequest(value: unknown): TaskRequest {
  const raw = codexRecord(value);
  return {
    ...raw,
    id:
      typeof raw.id === "string" || typeof raw.id === "number"
        ? raw.id
        : undefined,
    requestId: codexString(raw.requestId) ?? "",
    method: codexString(raw.method) ?? "",
    threadId: codexString(raw.threadId),
    params: raw.params === undefined ? undefined : codexRecord(raw.params),
  };
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}
function isCodexItem(value: unknown): value is ReferenceItem {
  if (
    !isCodexRecord(value) ||
    typeof value.type !== "string" ||
    !optionalString(value.text)
  )
    return false;
  return (
    value.content === undefined ||
    (Array.isArray(value.content) &&
      value.content.every(
        (entry: unknown) =>
          isCodexRecord(entry) &&
          typeof entry.type === "string" &&
          optionalString(entry.text),
      ))
  );
}
function isCodexTurn(value: unknown): value is CodexTurn {
  return (
    isCodexRecord(value) &&
    typeof value.id === "string" &&
    optionalString(value.status)
  );
}
function isCodexThread(value: unknown): value is CodexThread {
  return (
    isCodexRecord(value) &&
    typeof value.id === "string" &&
    optionalString(value.cwd) &&
    Array.isArray(value.turns) &&
    value.turns.every(isCodexTurn)
  );
}
function isCodexRequest(value: unknown): value is TaskRequest {
  return (
    isCodexRecord(value) &&
    typeof value.requestId === "string" &&
    typeof value.method === "string" &&
    (value.id === undefined ||
      typeof value.id === "string" ||
      typeof value.id === "number") &&
    optionalString(value.threadId) &&
    (value.params === undefined || isCodexRecord(value.params))
  );
}
function isCodexEvent(value: unknown): value is CodexEvent {
  if (!isCodexRecord(value) || typeof value.method !== "string") return false;
  if (
    !["timestamp", "turnId", "requestId", "status", "message", "at"].every(
      (key) => optionalString(value[key]),
    )
  )
    return false;
  if (value.threadId !== null && !optionalString(value.threadId)) return false;
  if (value.reason !== null && !optionalString(value.reason)) return false;
  if (value.request !== undefined && !isCodexRequest(value.request))
    return false;
  const params = value.params;
  return (
    params === undefined ||
    (isCodexRecord(params) &&
      optionalString(params.threadId) &&
      optionalString(params.clientRequestId) &&
      (params.turn === undefined || isCodexTurn(params.turn)) &&
      (params.thread === undefined ||
        (isCodexRecord(params.thread) && optionalString(params.thread.id))))
  );
}

export function codexRpcError(error: unknown) {
  return new Error(
    `Codex RPC ${codexProperty(error, "code")}: ${publicCodexValue(codexProperty(error, "message"))}`,
  );
}

export function publicCodexErrorMessage(error: unknown) {
  const message = codexErrorMessage(error);
  return message === undefined ? undefined : publicCodexValue(message);
}

export function codexToolContent(result: unknown) {
  return [{ type: "inputText", text: JSON.stringify(result) }];
}

/** Keep secrets and hidden reasoning out of the application event log and frontend. */
export function publicCodexValue(value: string): string;
export function publicCodexValue(value: CodexRequest): CodexRequest;
export function publicCodexValue(value: CodexRecord): CodexRecord;
export function publicCodexValue(value: unknown): unknown;
export function publicCodexValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .filter(
        (v: unknown) =>
          !v ||
          !["reasoning", "rawResponse"].some(
            (type) => type === codexProperty(v, "type"),
          ),
      )
      .map(publicCodexValue);
  if (value && typeof value === "object") {
    const out: CodexRecord = {};
    for (const [key, v] of Object.entries(value)) {
      if (
        /^(accessToken|refreshToken|idToken|apiKey|authorization|email|encryptedContent|reasoning|rawResponse|config|layers)$/i.test(
          key,
        )
      )
        continue;
      out[key] = publicCodexValue(v);
    }
    return out;
  }
  if (typeof value === "string")
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  return value;
}

export function readCodexReferenceReply(value: unknown) {
  const reply = readCodexThreadReply(publicCodexValue(value));
  return {
    ...reply,
    thread: {
      ...reply.thread,
      turns: reply.thread.turns.map((turn) => ({
        ...turn,
        items: Array.isArray(turn.items)
          ? turn.items.map(readCodexItem)
          : undefined,
      })),
    },
  };
}
