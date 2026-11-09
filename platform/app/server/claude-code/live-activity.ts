import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  LiveTurnActivity,
  LiveTurnState,
} from "../../shared/task-activity.js";
import { now } from "../storage.js";

/**
 * What a Claude Code turn is doing right now, read from the raw SDK stream. ClaudeLiveTurn
 * feeds it every message before its own filtering, because the messages that show liveness are
 * the ones turn.ts does not turn into events. Kept in memory and read on demand: a restart ends
 * the turn anyway, and a saved heartbeat would refetch every open tab's state on each beat.
 *
 * Message shapes, from @anthropic-ai/claude-agent-sdk 0.3.296 sdk.d.ts:
 * - SDKPartialAssistantMessage (l.5537): `{type: "stream_event", event, parent_tool_use_id}`;
 *   `event` is a Messages API stream event (`content_block_start` with `content_block.type`,
 *   `content_block_delta` with `delta.type` of text_delta, input_json_delta or thinking_delta).
 *   The CLI sends no thinking text in these sessions, so a thinking block's start is the signal.
 * - SDKThinkingTokensMessage (l.6193): `{type: "system", subtype: "thinking_tokens",
 *   estimated_tokens}`, the CLI's running estimate while the text is omitted.
 * - SDKAPIRetryMessage (l.3608): `{type: "system", subtype: "api_retry", attempt,
 *   retry_delay_ms}`.
 * - SDKStatusMessage (l.5956) with `SDKStatus = 'compacting' | 'requesting' | null` (l.5954).
 */
export class LiveActivityTracker {
  private state: LiveTurnState = "requesting";
  private since?: string;
  private lastSignalAt?: string;
  private outputChars = 0;
  private thinkingTokens?: number;
  private retry?: { attempt: number; delayMs: number };

  constructor(private readonly clock: () => string = now) {}

  observe(msg: SDKMessage): void {
    this.lastSignalAt = this.clock();
    this.since ??= this.lastSignalAt;
    if (msg.type === "stream_event") {
      // A subagent's stream proves the process is alive but is not this turn's own output.
      if (!msg.parent_tool_use_id) this.observeStream(msg.event);
    } else if (msg.type === "system") this.observeSystem(msg);
  }

  /** A tool result went back to the model, so the next thing it does is a new request. */
  toolResultReturned(): void {
    this.lastSignalAt = this.clock();
    this.enter("requesting");
  }

  snapshot(): LiveTurnActivity | undefined {
    if (!this.since || !this.lastSignalAt) return undefined;
    return {
      state: this.state,
      since: this.since,
      lastSignalAt: this.lastSignalAt,
      outputChars: this.outputChars,
      ...(this.thinkingTokens === undefined
        ? {}
        : { thinkingTokens: this.thinkingTokens }),
      ...(this.retry ? { retry: this.retry } : {}),
    };
  }

  private enter(state: LiveTurnState) {
    if (state !== this.state) {
      this.state = state;
      this.since = this.lastSignalAt;
    }
    // The estimate and the retry belong to one request; a new request or state starts clean.
    if (state === "requesting") this.thinkingTokens = undefined;
    if (state !== "retrying") this.retry = undefined;
  }

  private observeStream(
    event: Extract<SDKMessage, { type: "stream_event" }>["event"],
  ) {
    if (event.type === "content_block_start") {
      const block = event.content_block.type;
      if (block === "thinking" || block === "redacted_thinking")
        this.enter("thinking");
      else if (block === "text") this.enter("writing");
      else if (block === "tool_use" || block === "server_tool_use")
        this.enter("tool");
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta.type === "text_delta") {
        this.enter("writing");
        this.outputChars += delta.text.length;
      } else if (delta.type === "input_json_delta") {
        // Drafts are written as tool-call arguments, so this is the model's real output.
        this.enter("tool");
        this.outputChars += delta.partial_json.length;
      } else if (delta.type === "thinking_delta") this.enter("thinking");
    }
  }

  private observeSystem(msg: Extract<SDKMessage, { type: "system" }>) {
    if (msg.subtype === "thinking_tokens") {
      this.enter("thinking");
      this.thinkingTokens = msg.estimated_tokens;
    } else if (msg.subtype === "api_retry") {
      this.enter("retrying");
      this.retry = { attempt: msg.attempt, delayMs: msg.retry_delay_ms };
    } else if (msg.subtype === "status") {
      if (msg.status === "compacting") this.enter("compacting");
      else if (msg.status === "requesting") this.enter("requesting");
      else if (this.state === "compacting") this.enter("requesting");
    }
  }
}
