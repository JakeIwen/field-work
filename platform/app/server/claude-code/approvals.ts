import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

type ApprovalRequest = {
  id: string;
  requestId: string;
  method: string;
  threadId: string;
  turnId: string;
  params: Record<string, string>;
};
type Pending = {
  request: ApprovalRequest;
  settle: (result: PermissionResult) => void;
};
type Emit = (threadId: string, event: Record<string, unknown>) => void;

/**
 * Claude Code permission prompts shown as Fieldwork approval requests. They
 * reuse the Codex request methods, so the existing approval UI and its
 * accept-once / decline / cancel responses apply unchanged.
 */
export class ClaudeApprovals {
  private pending = new Map<string, Pending>();

  constructor(private readonly emit: Emit) {}

  requests() {
    return [...this.pending.values()].map((entry) => entry.request);
  }
  has(requestId: string) {
    return this.pending.has(requestId);
  }

  handler(threadId: string, turnId: string, autoApprove: string[]): CanUseTool {
    return (tool, input, { signal, title, description, blockedPath }) =>
      new Promise<PermissionResult>((resolve) => {
        if (blockedPath)
          return resolve({
            behavior: "deny",
            message:
              "Access outside the task's permitted paths is not allowed.",
          });
        if (autoApprove.includes(tool)) return resolve({ behavior: "allow" });
        const requestId = randomUUID();
        const path =
          typeof input.file_path === "string" ? input.file_path : blockedPath;
        const request: ApprovalRequest = {
          id: requestId,
          requestId,
          method:
            tool === "Bash"
              ? "item/commandExecution/requestApproval"
              : "item/fileChange/requestApproval",
          threadId,
          turnId,
          params: {
            reason: title ?? description ?? `Claude Code asks to use ${tool}.`,
            tool,
            ...(typeof input.command === "string"
              ? { command: input.command }
              : {}),
            ...(path ? { path } : {}),
          },
        };
        const settle = (result: PermissionResult) => {
          if (!this.pending.delete(requestId)) return;
          resolve(result);
          this.emit(threadId, {
            method: "adapter/requestAnswered",
            threadId,
            requestId,
          });
        };
        this.pending.set(requestId, { request, settle });
        signal.addEventListener(
          "abort",
          () => settle({ behavior: "deny", message: "Request cancelled." }),
          { once: true },
        );
        this.emit(threadId, {
          method: "adapter/request",
          threadId,
          turnId,
          request,
          status: "waiting_approval",
        });
      });
  }

  deny(threadId: string, reason: string) {
    for (const entry of [...this.pending.values()])
      if (entry.request.threadId === threadId)
        entry.settle({ behavior: "deny", message: reason });
  }

  respond(requestId: string | number, response: unknown) {
    const entry = this.pending.get(String(requestId));
    if (!entry)
      throw new Error(
        "Approval/input request no longer exists. Refresh the conversation.",
      );
    const decision = (response as { decision?: unknown } | null)?.decision;
    if (
      typeof decision !== "string" ||
      !["accept", "decline", "cancel"].includes(decision) ||
      Object.keys(response as object).some((key) => key !== "decision")
    )
      throw new Error(
        "Choose accept once, decline, or cancel. Session-wide approvals are not supported.",
      );
    entry.settle(
      decision === "accept"
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            message:
              decision === "cancel"
                ? "The user cancelled this request."
                : "The user declined this request.",
            interrupt: decision === "cancel",
          },
    );
    return { answered: true };
  }
}
