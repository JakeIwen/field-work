import { tunables } from "../../shared/tunables.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ManagedThread } from "../codex-selection.js";

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type TurnOutcome = { status: TurnStatus; error?: string };
export type AgentMessageItem = {
  type: "agentMessage";
  id: string;
  text: string;
};
export type ClaudeTurnRecord = {
  id: string;
  /** Every user message delivered to this turn, starting with the turn's own ID. */
  promptIds: string[];
  status: TurnStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
};
/** Codex's token-usage shape, so the task usage panel reads both providers alike. */
export type TokenTotals = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
export type ClaudeThread = ManagedThread & {
  provider: "claude";
  runtimeModel: string;
  /** False until Claude Code has created the session transcript that `resume` reads. */
  sessionStarted: boolean;
  turns: ClaudeTurnRecord[];
  usage?: TokenTotals;
};
/** The part of a Claude Code transcript entry that a thread view reads. */
export type TranscriptEntry = {
  type: string;
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
};
export type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { query?: unknown };
};

export const epochSeconds = (iso?: string) =>
  iso ? Math.floor(new Date(iso).valueOf() / 1000) : undefined;

/** Fieldwork-owned Claude Code conversations (`claude-threads.json`, backed up with personal data). */
export class ClaudeThreadRegistry {
  private threads: Record<string, ClaudeThread> = {};

  constructor(
    private readonly file: string,
    private readonly maxTurns: () => number = () =>
      tunables["models.claudeThreadTurns"].default,
  ) {
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      parsed.schemaVersion !== 1 ||
      !parsed.threads ||
      typeof parsed.threads !== "object"
    )
      throw new Error(
        "Invalid Claude Code thread registry. Restore it from your personal-data backup.",
      );
    this.threads = parsed.threads;
  }

  persist() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ schemaVersion: 1, threads: this.threads }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    renameSync(temp, this.file);
  }
  owns(id: string | undefined | null) {
    return !!id && Object.hasOwn(this.threads, id);
  }
  get(id: string): ClaudeThread | undefined {
    return this.owns(id) ? this.threads[id] : undefined;
  }
  own(id: string) {
    const thread = this.get(id);
    if (!thread)
      throw new Error(
        "This application does not own that Claude Code conversation. Unrelated conversations cannot be read or controlled.",
      );
    return thread;
  }
  list() {
    return Object.values(this.threads);
  }
  add(thread: ClaudeThread) {
    this.threads[thread.id] = thread;
    this.persist();
  }
  beginTurn(thread: ClaudeThread, id: string) {
    thread.activeTurnId = id;
    thread.uncertain = true;
    thread.turns = [
      ...thread.turns,
      {
        id,
        promptIds: [id],
        status: "inProgress" as const,
        startedAt: new Date().toISOString(),
      },
    ].slice(-this.maxTurns());
    this.persist();
  }
  endTurn(thread: ClaudeThread, id: string, outcome: TurnOutcome) {
    const record = thread.turns.find((turn) => turn.id === id);
    const completedAt = new Date().toISOString();
    if (record)
      Object.assign(record, {
        status: outcome.status,
        completedAt,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    if (thread.activeTurnId === id) delete thread.activeTurnId;
    thread.uncertain = false;
    this.persist();
    return completedAt;
  }
  /** A turn left running by a restart: its process is gone and it is never restarted. */
  abandonTurn(thread: ClaudeThread) {
    if (thread.activeTurnId)
      this.endTurn(thread, thread.activeTurnId, {
        status: "interrupted",
        error:
          "Fieldwork restarted during this turn. It was not restarted automatically.",
      });
  }
}

export function addTokenUsage(
  previous: TokenTotals | undefined,
  usage: Record<string, unknown>,
) {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const cached = count(usage.cache_read_input_tokens);
  const input =
    count(usage.input_tokens) +
    cached +
    count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const details = usage.output_tokens_details as
    { thinking_tokens?: unknown } | undefined;
  const last: TokenTotals = {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: count(details?.thinking_tokens),
  };
  const total = { ...last };
  for (const key of Object.keys(total) as (keyof TokenTotals)[])
    total[key] += previous?.[key] ?? 0;
  return { total, last };
}

/** Codex-shaped thread view: recorded turns with their assistant text from the session transcript. */
export function claudeThreadView(
  root: string,
  thread: ClaudeThread,
  transcript: TranscriptEntry[],
) {
  const owner = new Map<string, string>();
  for (const turn of thread.turns)
    for (const id of turn.promptIds) owner.set(id, turn.id);
  const items = new Map<string, AgentMessageItem[]>();
  let current: string | undefined;
  for (const entry of transcript) {
    if (entry.parent_tool_use_id) continue;
    if (entry.type === "user") {
      current = owner.get(entry.uuid) ?? current;
      continue;
    }
    const message = entry.message as
      { model?: string; content?: ContentBlock[] } | undefined;
    if (
      entry.type !== "assistant" ||
      !current ||
      message?.model === "<synthetic>"
    )
      continue;
    const turnItems = items.get(current) ?? [];
    (message?.content ?? []).forEach((block, index) => {
      if (block?.type === "text" && block.text)
        turnItems.push({
          type: "agentMessage",
          id: `${entry.uuid}:${index}`,
          text: block.text,
        });
    });
    items.set(current, turnItems);
  }
  return {
    id: thread.id,
    cwd: path.resolve(root, thread.cwd),
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      items: items.get(turn.id) ?? [],
      error: turn.error ? { message: turn.error } : null,
      completedAt: epochSeconds(turn.completedAt),
    })),
  };
}
