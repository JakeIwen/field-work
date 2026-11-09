import { holdPdfValidation } from "./validation-barrier.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../../server/task-kinds/registry.js";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./sample-workspace.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";
import {
  preparePostingDocumentBundle,
  questionReferenceId,
} from "../../server/question-context.js";
import { documentOpeningHash } from "../../server/preparation-documents.js";
import { ApplicationPreparationManager } from "../../server/application-preparation.js";
import { sendOverflowFollowup } from "../../server/overflow-followup.js";
import { openFixtureWorkspace } from "./http-workspace.js";
import { saveMaterialPdfs } from "./material-records.js";
import { legacyOpening, legacyTask } from "./legacy-records.js";

function interceptSwift(directory: string, failures: number) {
  const executable = path.join(directory, "bin/swift");
  const counter = path.join(directory, "render-count");
  atomicWrite(
    executable,
    `#!/bin/sh
case "$3" in
  */render_resume.swift)
    count=0
    if test -f '${counter}'; then read -r count < '${counter}'; fi
    count=$((count + 1))
    printf '%s\\n' "$count" > '${counter}'
    if test "$count" -le ${failures}; then
      printf '%s\\n' 'Layout report: {"page":2,"lineHeight":13.23,"blocks":[{"text":"Owned a production Rails insurance portal","lines":4,"lastLineChars":10}]}' >&2
      printf '%s:101: Fatal error: Page 2 overflowed by 1.12 points\\n' "$3" >&2
      exit 1
    fi
    ;;
  */verify-pdf.swift)
    if test -f '${directory}/hold-validation'; then
      /usr/bin/swift "$@" || exit $?
      printf 'ready' > '${directory}/validation-started'
      while ! test -f '${directory}/validation-release'; do /bin/sleep 0.01; done
      exit 0
    fi
    ;;
esac
exec /usr/bin/swift "$@"
`,
  );
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = path.dirname(executable) + path.delimiter + oldPath;
  return () => {
    process.env.PATH = oldPath;
  };
}

export function overflowEventServices(
  store: TaskEventServices["store"],
  publish: TaskEventServices["publish"] = () => {},
): TaskEventServices {
  return {
    store,
    publish,
    launchingTask: () => undefined,
    openingOperation: async (_key, action) => action(),
    generatePreparedAutofill: async () => {
      throw new Error("No autofill expected");
    },
  };
}

type FixtureWorkspace = Awaited<ReturnType<typeof openFixtureWorkspace>>;

function mockOverflowAgent(t: TestContext, workspace: FixtureWorkspace) {
  const store = workspace.store;
  const status = workspace.agent.status();
  t.mock.method(workspace.agent, "status", () => ({
    ...status,
    available: true,
    connected: true,
  }));
  t.mock.method(workspace.agent, "connect", async () =>
    workspace.agent.status(),
  );
  t.mock.method(workspace.agent, "resume", async () => ({}));
  t.mock.method(workspace.agent, "interrupt", async () => ({
    interrupted: true,
  }));
  const followups: string[] = [];
  let beforeFollowup = async () => {};
  t.mock.method(
    workspace.agent,
    "send",
    async (threadId: string, prompt: string) => {
      followups.push(prompt);
      handleTaskEvent(overflowEventServices(store), {
        method: "turn/started",
        threadId,
        params: {
          clientRequestId: store.taskForThread(threadId)?.messages.at(-1)
            ?.clientRequestId,
          turn: { id: `revision-${followups.length}` },
        },
      });
      await beforeFollowup();
      const task = store.taskForThread(threadId);
      assert.ok(task, "follow-up task must survive");
      store.put("task", task.id, {
        ...task,
        status: "completed",
        activeTurnId: null,
      });
      await renderApplicationDocuments(
        store,
        task.id,
        `revision-${followups.length}`,
      );
      return { turnId: `revision-${followups.length}` };
    },
  );
  return {
    followups,
    beforeFollowup(action: () => Promise<void>) {
      beforeFollowup = action;
    },
  };
}

function overflowManager(workspace: FixtureWorkspace) {
  const store = workspace.store;
  const manager = new ApplicationPreparationManager(store, {
    changed() {},
    generateScript: async () => {
      throw new Error("No form expected");
    },
    startAnswers: async () => null,
    startTask: async () => {
      throw new Error("Fixture task already completed");
    },
    createDocuments: async (run, preset) => {
      assert.equal(preset, "posting-resume");
      const task = legacyTask({
        id: randomUUID(),
        preset: "posting-resume",
        status: "completed",
        threadId: randomUUID(),
        preparationId: run.id,
        context: { openingId: "one", applicationId: run.applicationId },
        preparationOpeningHash: documentOpeningHash(store.opening("one")),
        postingLabel: "Fixture Engineer",
        posting: {
          kind: "pasted",
          text: "Controlled rendering fixture",
          hash: "fixture-posting",
        },
      });
      const prepared = preparePostingDocumentBundle(store, task, {
        id: questionReferenceId,
        text: "Synthetic context",
      });
      store.put("task", task.id, { ...task, ...prepared });
      await renderApplicationDocuments(store, task.id, "initial");
      return store.get("task", task.id);
    },
    followUpTask: (
      id: string,
      prompt: string,
      requestId: string,
      guard: () => void,
    ) =>
      sendOverflowFollowup(
        {
          store,
          agent: workspace.agent,
          publish() {},
          taskOperation: async (_id, action) => action(),
        },
        id,
        prompt,
        requestId,
        guard,
      ),
  });
  return manager;
}

export async function overflowPreparationFixture(
  t: TestContext,
  failures = 1,
  root = repositoryRoot,
) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "overflow-preparation-"),
  );
  const restorePath = interceptSwift(directory, failures);
  let workspace: Awaited<ReturnType<typeof openFixtureWorkspace>> | undefined;
  let manager: ApplicationPreparationManager | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await manager?.close();
      } finally {
        try {
          await workspace?.close();
        } finally {
          restorePath();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    })());
  // Setup can fail before the caller receives its fixture and enters a finally block.
  t.after(close);
  workspace = await openFixtureWorkspace(root, path.join(directory, "data"));
  const store = workspace.store;
  store.put(
    "cache_opening",
    "one",
    legacyOpening({
      id: "one",
      company: "Fixture",
      company_id: "fixture",
      title: "Engineer",
      url: "https://example.com/role",
    }),
  );
  const original = saveMaterialPdfs(store, "original");
  const agentFixture = mockOverflowAgent(t, workspace);
  manager = overflowManager(workspace);
  return {
    workspace,
    store,
    manager,
    original,
    ...agentFixture,
    holdValidation: () => holdPdfValidation(directory),
    close,
  };
}
