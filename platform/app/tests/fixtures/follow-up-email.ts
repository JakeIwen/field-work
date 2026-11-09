import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite, Store } from "../../server/storage.js";
import type { Application } from "../../shared/types.js";
import type { Task } from "../../shared/task-records.js";
import type { FollowUpTaskServices } from "../../server/follow-up-email-task.js";
import type { TaskCreationOptions } from "../../server/task-kinds/registry.js";
import type { GmailSender } from "../../server/gmail/send.js";
import { legacyDocument, legacyOpening, legacyTask } from "./legacy-records.js";

export const followUpCoverLetter =
  "Dear Acme team,\n\nThe sample import pipeline validates incoming records before publishing updates.\n\nSincerely,\nSam Rivera";
export const followUpBody = `Hello Acme team,

I applied for the Senior Engineer role on October 4 and wanted to add one point to my cover letter. The posting's emphasis on keeping integrations reliable as upstream systems change matches the import-pipeline validation example I described there.

Would a short conversation help with your review?

Best,
Sam Rivera`;

export const followUpApplication = (): Application => ({
  id: "app",
  openingId: "opening",
  status: "applied",
  nextAction: "",
  followUp: "2026-10-12",
  contacts: "Dana Recruiter dana@acme.example",
  notes: "",
  documentIds: ["letter"],
  version: 3,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
  submittedAt: "2026-10-04T10:00:00.000Z",
  submissionSource: "autofill-copy",
  packages: [
    {
      id: "pack",
      at: "2026-10-04T10:00:00.000Z",
      documents: [
        {
          id: "letter",
          hash: "a".repeat(64),
          kind: "cover-letter",
          name: "letter.pdf",
        },
      ],
    },
  ],
});

export function followUpFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-follow-up-"));
  const store = new Store(root, path.join(root, ".local/data"));
  for (const file of [
    "AGENTS.md",
    "source_data/resume.md",
    "source_data/github_evidence_dossier.md",
  ])
    atomicWrite(
      path.join(root, file),
      `Synthetic ${file}. No production claims.`,
    );
  store.put(
    "cache_opening",
    "opening",
    legacyOpening({
      id: "opening",
      company: "Acme Labs",
      company_id: "acme",
      title: "Senior Engineer",
      url: "https://job-boards.greenhouse.io/acme/jobs/1",
      location: "Remote, US",
      description:
        "Build and maintain integrations that keep working as upstream systems change. ".repeat(
          3,
        ),
      hash: "opening-hash",
    }),
  );
  store.put(
    "generated_document",
    "letter",
    legacyDocument({
      id: "letter",
      kind: "cover-letter",
      name: "letter.pdf",
      text: followUpCoverLetter,
    }),
  );
  store.put("application", "app", followUpApplication());
  let closed = false;
  const closeStore = () => {
    if (!closed) store.close();
    closed = true;
  };
  return {
    root,
    store,
    closeStore,
    close: () => {
      closeStore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Task services that record calls instead of starting an agent. `idle()`
 * waits for every request's background work; `hold()` delays the next
 * revision delivery until the returned release function is called.
 */
export function fakeTaskServices(store: Store) {
  const pending: Promise<void>[] = [];
  let gate: Promise<void> | undefined;
  const calls = {
    created: [] as Record<string, unknown>[],
    options: [] as (TaskCreationOptions | undefined)[],
    started: [] as string[],
    messages: [] as { taskId: string; prompt: string; requestId: string }[],
  };
  const services: FollowUpTaskServices = {
    store,
    createTask: async (body, options) => {
      calls.created.push(body);
      calls.options.push(options);
      return store.put(
        "task",
        `task-${calls.created.length}`,
        legacyTask({
          id: `task-${calls.created.length}`,
          preset: "follow-up-email",
          status: "handoff",
          prompt: String(body.prompt),
          clientRequestId: String(body.clientRequestId),
          context: body.context as Task["context"],
          threadId: null,
          version: 1,
        }),
      );
    },
    startTask: async (id) => {
      calls.started.push(id);
      const task = store.get("task", id)!;
      return store.put("task", id, {
        ...task,
        status: "running",
        threadId: `thread-${id}`,
        activeTurnId: "turn-1",
      });
    },
    sendMessage: async (taskId, prompt, requestId) => {
      calls.messages.push({ taskId, prompt, requestId });
      if (gate) await gate;
      const task = store.get("task", taskId)!;
      store.put("task", taskId, {
        ...task,
        status: "running",
        activeTurnId: "turn-2",
      });
    },
    changed: () => {},
    background: (work) => void pending.push(work),
  };
  const finishTurn = (taskId: string) =>
    store.put("task", taskId, {
      ...store.get("task", taskId)!,
      status: "completed",
      activeTurnId: null,
    });
  const hold = () => {
    let release = () => {};
    gate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      gate = undefined;
      release();
    };
  };
  return {
    services,
    calls,
    finishTurn,
    hold,
    idle: () => Promise.all(pending).then(() => undefined),
  };
}

/** A Gmail double that stores what it was asked to send and returns it as Gmail's copy. */
export function fakeSender(transform: (raw: string) => string = (raw) => raw) {
  const sent: string[] = [];
  const sender: GmailSender & { sent: string[] } = {
    sent,
    identity: async () => ({
      email: "candidate@example.net",
      name: "Sam Rivera",
    }),
    send: async (raw) => {
      sent.push(raw);
      return { id: `a${sent.length}`, threadId: `b${sent.length}` };
    },
    raw: async (id) =>
      Buffer.from(transform(sent[Number(id.slice(1)) - 1]), "utf8"),
  };
  return sender;
}
