import type { TaskStatus } from "./types.js";

/**
 * Progress summary a task carries between its saved events. The server reduces it from the
 * adapter's Codex-shaped events (both providers) in the same transaction as the event append;
 * legacy tasks have none, so every consumer treats it as optional.
 */
export type TaskActivity = {
  /** Turns started on this task since the summary began; 1 when a turn was already running. */
  turn: number;
  /** Start of the current or last turn. */
  turnStartedAt?: string;
  /** Set when the current turn ends (completed, failed, interrupted, disconnected); cleared on the next start. */
  turnCompletedAt?: string;
  /** Tool calls in the current turn, counted once per tool item/started. */
  toolCalls: number;
  /** Time of the newest adapter event. */
  lastEventAt: string;
  /** Short label of the newest notable event, such as "read github_evidence_dossier.md". */
  lastEvent?: string;
};

export type LiveTurnState =
  "requesting" | "thinking" | "writing" | "tool" | "retrying" | "compacting";

/**
 * What a live turn is doing right now, kept in memory by the adapter from its raw stream and
 * read on demand. It is never saved or published: a restart ends the turn anyway, and a
 * persisted heartbeat would refetch every open tab's state on each beat.
 */
export type LiveTurnActivity = {
  state: LiveTurnState;
  /** When the current state began. */
  since: string;
  /** Newest raw signal from the SDK or app-server, whatever its kind. */
  lastSignalAt: string;
  /** Characters of model output this turn: text plus tool-call input (drafts are written through a tool). */
  outputChars: number;
  /** The CLI's live estimate while thinking text is omitted; absent when it sends none. */
  thinkingTokens?: number;
  retry?: { attempt: number; delayMs: number };
};

export type PreparationTaskRole = "documents" | "answers";

/** One task of a preparation run with its live turn view; `live` is null when no turn is active. */
export type PreparationTaskActivity = {
  id: string;
  role: PreparationTaskRole;
  status: TaskStatus;
  model?: string;
  effort?: string;
  live: LiveTurnActivity | null;
};
