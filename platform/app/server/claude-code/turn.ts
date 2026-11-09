import { tunables } from "../../shared/tunables.js";
import { realpathSync } from "node:fs";
import type {
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { publicCodexValue } from "../codex.js";
import { claudeBaseModel } from "./models.js";
import { LiveActivityTracker } from "./live-activity.js";
import { ClaudeInput } from "./session.js";
import { CLAUDE_TOOL_SERVER, type ClaudeSessionPolicy } from "./tools.js";
import type { AgentMessageItem, ContentBlock, TurnOutcome } from "./threads.js";

export type TurnHost = {
  /** Emit a Codex-shaped event about this turn. */
  emit: (method: string, params: Record<string, unknown>) => void;
  /** The session passed its checks, so Claude Code has created its transcript. */
  started: () => void;
  usage: (usage: Record<string, unknown>) => void;
  /** Record the outcome; `announce` is false for a turn that never started. */
  finished: (
    outcome: TurnOutcome,
    items: AgentMessageItem[],
    announce: boolean,
  ) => void;
};

/** Grace period for a process to exit after its input closes or an interrupt is sent. */
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * One Claude Code process running one Fieldwork turn: it streams the
 * process's messages into Codex-shaped events, accepts steering while the
 * turn runs, and ends once every delivered message has a result.
 */
export class ClaudeLiveTurn {
  readonly input = new ClaudeInput();
  readonly abort = new AbortController();
  /** Fed every raw SDK message, including the ones this class does not turn into events. */
  readonly activity = new LiveActivityTracker();
  session!: Query;
  interrupted = false;
  finished = false;
  verified = false;
  private readonly outstanding: Set<string>;
  private outcome: TurnOutcome = { status: "completed" };
  private items: AgentMessageItem[] = [];
  private streamMessageId?: string;
  private stderr = "";
  private resolveStart!: () => void;
  private rejectStart!: (error: Error) => void;
  private readonly start = new Promise<void>((resolve, reject) => {
    this.resolveStart = resolve;
    this.rejectStart = reject;
  });

  constructor(
    readonly id: string,
    readonly policy: ClaudeSessionPolicy,
    readonly cwd: string,
    private readonly runtimeModel: string,
    private readonly host: TurnHost,
    private readonly settleDelay = () =>
      tunables["models.claudeCloseGraceS"].default * 1000,
  ) {
    this.outstanding = new Set([id]);
    this.start.catch(() => {});
  }

  appendStderr(data: string) {
    this.stderr = (this.stderr + data).slice(-6000);
  }

  /** Wait for Claude Code to confirm the session; a slow or refused start fails the turn. */
  async started(timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.start,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Claude Code did not start the turn in time. It was stopped; send the message again.",
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.abort.abort();
      this.finish({ status: "failed", error: message(error) });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async consume() {
    try {
      for await (const msg of this.session) this.receive(msg);
    } catch (error) {
      // After the last result, or after an interrupt, the process may still exit nonzero.
      if (!this.finished && !this.interrupted)
        this.outcome = {
          status: "failed",
          error: this.failure(message(error)),
        };
    } finally {
      this.rejectStart(
        new Error(this.outcome.error || "Claude Code exited before starting."),
      );
      this.finish(
        this.interrupted
          ? { status: "interrupted" }
          : this.outcome.status === "failed"
            ? this.outcome
            : {
                status: "failed",
                error: this.failure(
                  "Claude Code exited before finishing the turn.",
                ),
              },
      );
    }
  }

  steer(id: string, prompt: string) {
    if (this.finished || !this.verified)
      throw new Error(
        "There is no active turn to steer. Send a follow-up message instead.",
      );
    this.outstanding.add(id);
    this.input.push(id, prompt);
  }

  finish(outcome: TurnOutcome) {
    if (this.finished) return;
    this.finished = true;
    this.input.close();
    this.host.finished(outcome, this.items, this.verified);
    // Closing input ends the process; force it only if it lingers.
    setTimeout(() => this.session?.close(), this.settleDelay()).unref();
  }

  /** Stop the turn, forcing the process down if Claude Code does not confirm in time. */
  async interrupt() {
    this.interrupted = true;
    setTimeout(() => {
      if (this.finished) return;
      this.abort.abort();
      this.finish({ status: "interrupted" });
    }, this.settleDelay()).unref();
    try {
      await this.session.interrupt();
    } catch {
      this.abort.abort();
    }
  }

  private failure(reason: string) {
    const detail = this.stderr.trim().split("\n").slice(-3).join(" ").trim();
    return String(publicCodexValue(detail ? `${reason} ${detail}` : reason));
  }

  private receive(msg: SDKMessage) {
    if (this.finished) return;
    this.activity.observe(msg);
    if (msg.type === "system" && msg.subtype === "init") {
      if (!this.verified) this.verify(msg);
      return;
    }
    if (!this.verified) return;
    if (msg.type === "stream_event") {
      if (msg.parent_tool_use_id) return;
      const event = msg.event;
      if (event.type === "message_start")
        this.streamMessageId = event.message.id;
      else if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      )
        this.host.emit("item/agentMessage/delta", {
          itemId: `${this.streamMessageId}:${event.index}`,
          delta: event.delta.text,
        });
    } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      if (msg.error)
        this.outcome = {
          status: "failed",
          error: `Claude Code reported ${msg.error}.`,
        };
      this.receiveAssistant(msg.uuid, msg.message);
    } else if (msg.type === "result") this.receiveResult(msg);
  }

  private receiveAssistant(
    uuid: string,
    message: { model?: string; content?: unknown },
  ) {
    if (message.model === "<synthetic>" || !Array.isArray(message.content))
      return;
    (message.content as ContentBlock[]).forEach((block, index) => {
      if (block?.type === "text" && block.text) {
        const item: AgentMessageItem = {
          type: "agentMessage",
          id: `${uuid}:${index}`,
          text: block.text,
        };
        this.items.push(item);
        this.host.emit("item/completed", { item });
      } else if (block?.type === "tool_use")
        this.host.emit("item/started", {
          item: {
            type: block.name === "WebSearch" ? "webSearch" : "toolCall",
            id: block.id,
            tool: block.name,
            ...(block.name === "WebSearch"
              ? { query: block.input?.query }
              : {}),
          },
        });
    });
  }

  private receiveResult(result: SDKResultMessage) {
    this.host.usage(result.usage as Record<string, unknown>);
    const answered = result.user_message_uuids?.length
      ? result.user_message_uuids
      : result.user_message_uuid
        ? [result.user_message_uuid]
        : [...this.outstanding];
    for (const id of answered) this.outstanding.delete(id);
    if (this.interrupted) this.outcome = { status: "interrupted" };
    else if (result.subtype !== "success" || result.is_error) {
      const detail =
        result.subtype !== "success"
          ? result.errors.join(" ")
          : result.result.slice(0, 500);
      this.outcome = {
        status: "failed",
        error: this.failure(
          `Claude Code turn failed (${result.terminal_reason ?? result.subtype}).${detail ? ` ${detail}` : ""}`,
        ),
      };
    }
    if (!this.outstanding.size) this.finish(this.outcome);
  }

  /** Refuse a session that is broader than the task's policy or billed differently. */
  private verify(init: SDKSystemMessage) {
    const problem = this.verificationProblem(init);
    if (problem) {
      this.outcome = { status: "failed", error: `${problem} No turn was run.` };
      this.abort.abort();
      this.rejectStart(new Error(this.outcome.error));
      return;
    }
    this.verified = true;
    this.host.started();
    this.host.emit("turn/started", {
      turn: { id: this.id, status: "inProgress", items: [] },
    });
    this.resolveStart();
  }
  private verificationProblem(init: SDKSystemMessage) {
    const expected = new Set([
      ...this.policy.tools,
      ...this.policy.allowedTools.filter((tool) => tool.startsWith("mcp__")),
    ]);
    const servers = init.mcp_servers ?? [];
    const needsServer = this.policy.dynamicTools.length > 0;
    if (claudeBaseModel(init.model) !== claudeBaseModel(this.runtimeModel))
      return "Claude Code did not confirm the selected model.";
    if (init.apiKeySource !== "none")
      return "Claude Code is using API-key billing. Fieldwork uses the Claude subscription sign-in only.";
    if (init.permissionMode !== this.policy.permissionMode)
      return "Claude Code did not confirm the task's permission mode.";
    if (realpathSync(init.cwd) !== this.cwd)
      return "Claude Code started outside the task's draft directory.";
    if (
      init.tools.some((tool) => !expected.has(tool)) ||
      servers.some((server) => server.name !== CLAUDE_TOOL_SERVER) ||
      (needsServer &&
        !servers.some(
          (server) =>
            server.name === CLAUDE_TOOL_SERVER && server.status === "connected",
        ))
    )
      return "Claude Code returned a broader or unverifiable tool set.";
    return null;
  }
}
