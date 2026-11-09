/** Real integration probe, intentionally separate from offline protocol fixtures. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexAdapter } from "../server/codex.js";
import { repositoryRoot as root } from "../server/paths.js";

const dataDir = path.resolve(
  process.env.JOB_SEARCH_DATA ?? path.join(root, ".local/codex-verification"),
);
const draft = path.join(
  dataDir,
  "drafts",
  `codex-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(draft, { recursive: true });
writeFileSync(
  path.join(draft, "AGENTS.md"),
  "Protocol verification only. Never use tools, change files, inspect other conversations, or access external services. Reply with the requested exact text.\n",
);
let events: any[] = [];
const summaries: any[] = [];
let probeThreadId: string | undefined;
let probeTurnId: string | undefined;
const create = () =>
  new CodexAdapter({
    root,
    dataDir,
    onEvent: (event) => {
      events.push(event);
      if (
        [
          "item/agentMessage/delta",
          "turn/started",
          "turn/completed",
          "adapter/request",
          "adapter/turnUncertain",
        ].includes(event.method)
      ) {
        const summary = {
          method: event.method,
          threadId: event.threadId,
          turnId: event.turnId,
          delta: event.params?.delta,
          status: event.params?.turn?.status,
        };
        summaries.push(summary);
        console.log(JSON.stringify(summary));
      }
    },
  });
let adapter = create();
const waitFor = async (method: string, turnId: string, seconds = 120) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const event = events.find(
      (e) => e.method === method && e.turnId === turnId,
    );
    if (event) return event;
    if (!adapter.status().connected)
      throw new Error(adapter.status().reason || "Disconnected");
    if (adapter.status().pendingRequests.length)
      throw new Error(
        "The probe received an actual approval/input request. It was not auto-approved. Use the application UI to continue.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${method}; the turn was not restarted.`,
  );
};
const assertReply = (event: any, expected: string) => {
  if (event.params.turn.status !== "completed")
    throw new Error(`Turn ended with ${event.params.turn.status}.`);
  const messages = events
    .filter(
      (e) =>
        e.method === "item/completed" &&
        e.params?.item?.type === "agentMessage" &&
        e.turnId === event.turnId,
    )
    .map((e) => e.params.item.text)
    .join("\n");
  if (!messages.includes(expected))
    throw new Error(
      "The real completed turn did not contain the expected reply.",
    );
};
const readTurnStatus = async (threadId: string, turnId: string) => {
  const detail = await adapter.read(threadId);
  const turn = detail.thread.turns?.find(
    (candidate: any) => candidate.id === turnId,
  );
  if (!turn)
    throw new Error(`Probe turn ${turnId} is missing from thread history.`);
  return turn.status as string;
};
const verifyInterruptLifecycle = async (threadId: string, turnId: string) => {
  let status = await readTurnStatus(threadId, turnId);
  if (status === "completed") return "completed before interruption";
  if (status !== "inProgress")
    throw new Error(`Interrupt probe turn was unexpectedly ${status}.`);

  let interrupt;
  try {
    interrupt = await adapter.interrupt(threadId);
  } catch (error: any) {
    // Codex can complete between thread/read and turn/interrupt. Confirm the
    // exact turn's terminal state instead of starting or interrupting again.
    status = await readTurnStatus(threadId, turnId);
    if (status === "completed") return "completed during interruption race";
    throw error;
  }
  if (!interrupt.interrupted) {
    status = await readTurnStatus(threadId, turnId);
    if (status === "completed") return "completed during interruption race";
    throw new Error(
      `Interrupt was declined while the probe turn was ${status}.`,
    );
  }
  const terminal = await waitFor("turn/completed", turnId);
  if (terminal.params.turn.status !== "interrupted")
    throw new Error(
      `Interrupt was accepted but the probe turn ended ${terminal.params.turn.status}.`,
    );
  return "interrupted while active";
};
try {
  const status = await adapter.connect();
  console.log(
    JSON.stringify(
      {
        available: status.available,
        reason: status.reason,
        auth: status.auth,
        version: status.version,
        selected: status.selected,
        models: status.models,
      },
      null,
      2,
    ),
  );
  if (!status.available) throw new Error(status.reason || "Codex unavailable");
  const first = await adapter.start({
    cwd: draft,
    prompt:
      "Reply exactly JRI_CODEX_CONNECTED. Do not use tools or edit files.",
  });
  probeThreadId = first.threadId;
  probeTurnId = first.turnId;
  assertReply(
    await waitFor("turn/completed", first.turnId),
    "JRI_CODEX_CONNECTED",
  );
  const second = await adapter.send(
    first.threadId,
    "Reply exactly JRI_FOLLOWUP_CONNECTED. Do not use tools or edit files.",
  );
  assertReply(
    await waitFor("turn/completed", second.turnId),
    "JRI_FOLLOWUP_CONNECTED",
  );
  const history = await adapter.read(first.threadId);
  if (history.thread.turns.length < 2)
    throw new Error("Thread read did not recover both completed turns.");
  adapter.close();
  adapter = create();
  events = [];
  await adapter.connect();
  const resumed = await adapter.resume(first.threadId);
  if (resumed.thread.id !== first.threadId)
    throw new Error("Resume returned a different thread.");
  const third = await adapter.send(
    first.threadId,
    "Compose a long explanation of sorting algorithms. Do not use tools or edit files. This turn will be interrupted as a protocol test.",
  );
  probeTurnId = third.turnId;
  const interruption = await verifyInterruptLifecycle(
    first.threadId,
    third.turnId,
  );
  console.log(
    JSON.stringify(
      {
        verified: true,
        threadId: first.threadId,
        checks: [
          "real streamed reply",
          "follow-up",
          "read history",
          "restart and resume",
          interruption,
        ],
      },
      null,
      2,
    ),
  );
} catch (error: any) {
  console.error(
    JSON.stringify(
      {
        verified: false,
        reason: error.message,
        threadId: probeThreadId ?? null,
        turnId: probeTurnId ?? null,
        recovery:
          "The probe did not retry or start another turn. Inspect the saved thread and probe-results.json before deciding whether to rerun it.",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  adapter.close();
  writeFileSync(
    path.join(draft, "probe-results.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        threadId: probeThreadId ?? null,
        turnId: probeTurnId ?? null,
        events: summaries,
        exitCode: process.exitCode || 0,
      },
      null,
      2,
    ) + "\n",
  );
}
