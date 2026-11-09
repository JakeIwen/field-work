import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createWorkspace } from "../server/server.js";
import { Store } from "../server/storage.js";
import {
  hasActiveTaskWork,
  remainingTaskWork,
} from "../server/workspace-activity.js";
import { assertDeletionIdle } from "../server/record-deletion.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import { startAutofillAnswers } from "../server/task-kinds/autofill-answers.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import {
  saveMaterialPdfs,
  materialBytes,
  materialAnswerFixture,
} from "./fixtures/material-records.js";

async function crashDuringPublication(
  f: ReturnType<typeof applicationAnswerFixture>,
) {
  const child = fork(
    new URL("./fixtures/autofill-crash-worker.ts", import.meta.url),
    [],
    {
      execArgv: ["--import", "tsx"],
      signal: AbortSignal.timeout(15000),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let errors = "";
  child.stderr?.on("data", (data) => {
    errors += data;
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", (message) =>
        message === "saving" ? resolve() : reject(new Error(String(message))),
      );
      child.once("exit", () =>
        reject(new Error(`Worker exited before saving: ${errors}`)),
      );
      child.once("error", reject);
    });
    child.send({ root: f.root, api: f.api, form: f.form, payload: f.payload });
    await ready;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}

async function assertRetry(
  store: Store,
  f: ReturnType<typeof applicationAnswerFixture>,
  ids: string[],
) {
  const record = await generateAutofill(store, "one", f.read);
  let launches = 0;
  const retry = await startAutofillAnswers(
    {
      store,
      taskActive: () => false,
      createTask: async () => {
        launches++;
        return legacyTask({ id: "retry", status: "handoff" });
      },
    },
    record,
    true,
  );
  assert.equal(
    retry?.id,
    "retry",
    "explicit answer retry must not return the stale task",
  );
  assert.equal(launches, 1);
  const manager = new ApplicationPreparationManager(store, {
    changed() {},
    generateScript: (id, documents, preparationId) =>
      generateAutofill(store, id, f.read, {
        documentIds: documents,
        preparationId,
      }),
    createDocuments: async () => {
      assert.fail("valid PDFs must be reused");
    },
    startTask: async () => {
      assert.fail("startup/retry must not restart the old turn");
    },
    startAnswers: (script) =>
      startAutofillAnswers(
        {
          store,
          taskActive: () => false,
          createTask: async () => {
            assert.fail("published answers are reusable");
          },
        },
        script,
      ),
  });
  try {
    manager.start("one");
    for (let i = 0; i < 8; i++) await manager.tick();
    assert.equal(
      manager.latest("one")?.status,
      "ready",
      manager.latest("one")?.error,
    );
    assert.deepEqual(manager.latest("one")?.documentIds, ids);
  } finally {
    await manager.close();
  }
}

test(
  "G7: restart recovers a crashed answer save without phantom work or lost artifacts",
  { timeout: 20000 },
  async () => {
    const f = materialAnswerFixture();
    const ids = saveMaterialPdfs(f.store, "original", f.api);
    const before = materialBytes(f.store, ids);
    f.store.close();
    let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
    try {
      await crashDuringPublication(f);
      const crashed = new Store(f.root, `${f.root}/.local/data`);
      const answers = crashed.list("application_answer_set");
      assert.equal(
        crashed.get("task", "task")?.autofillResult?.status,
        "saving",
      );
      assert.equal(
        answers.length,
        1,
        "answers published before the blocked form read",
      );
      crashed.close();
      workspace = await createWorkspace({
        root: f.root,
        dataDir: `${f.root}/.local/data`,
        port: 0,
        watch: false,
        connectAgent: false,
      });
      const store = workspace.store;
      assert.equal(store.get("task", "task")?.autofillResult?.status, "failed");
      assert.match(
        store.get("task", "task")?.autofillResult?.error ?? "",
        /restarted.*Retry/i,
      );
      assert.equal(hasActiveTaskWork(store), false);
      assert.deepEqual(remainingTaskWork(store), []);
      assert.doesNotThrow(() => assertDeletionIdle(store));
      assert.deepEqual(store.list("application_answer_set"), answers);
      assert.deepEqual(materialBytes(store, ids), before);
      assert.equal(store.list("task").length, 2, "restart launches nothing");
      await assertRetry(store, f, ids);
      assert.deepEqual(materialBytes(store, ids), before);
    } finally {
      await workspace?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
