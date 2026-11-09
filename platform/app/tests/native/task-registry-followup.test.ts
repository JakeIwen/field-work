import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { draftPath } from "../../server/bundles.js";
import { sampleWorkspaceRoot as repositoryRoot } from "../fixtures/sample-workspace.js";
import type { Records } from "../../server/records.js";
import { MissingRecordError, Store, sha256 } from "../../server/storage.js";
import { handleTaskEvent } from "../../server/task-kinds/registry.js";
import { WorkspaceRuntime } from "../../server/task-kinds/workspace-runtime.js";
import { legacyBundle, legacyTask } from "../fixtures/legacy-records.js";

async function withStore(prefix: string, run: (store: Store) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new Store(repositoryRoot, dataDir);
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function withRuntime(
  prefix: string,
  run: (runtime: WorkspaceRuntime) => Promise<void>,
) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = new WorkspaceRuntime({
    root: repositoryRoot,
    dataDir,
    port: 0,
    connectAgent: false,
  });
  try {
    await run(runtime);
  } finally {
    await runtime.gmail.close();
    runtime.store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test(
  "posting completion retains the render turn when its bundle disappears",
  { skip: process.platform !== "darwin", timeout: 180000 },
  async () =>
    withStore("task-completion-", async (store) => {
      const id = randomUUID();
      const threadId = "document-thread";
      const turnId = "document-turn";
      store.put(
        "task",
        id,
        legacyTask({
          id,
          preset: "posting-cover-letter",
          status: "running",
          threadId,
          posting: {
            title: "Example role",
            hash: sha256("Example posting"),
          },
          postingLabel: "Example role",
        }),
      );
      store.put(
        "bundle",
        id,
        legacyBundle({
          id,
          paths: ["cover_letter.txt", "source_data/resume.md"],
        }),
      );
      const resumePath = draftPath(store, id, "source_data");
      mkdirSync(resumePath, { recursive: true });
      writeFileSync(
        draftPath(store, id, "cover_letter.txt"),
        "Dear hiring team,\n\nThis deterministic fixture verifies document completion recovery.\n\nThank you,\nFixture Person",
      );
      writeFileSync(
        draftPath(store, id, "source_data/resume.md"),
        "# Fixture Person\n\nfixture@example.invalid",
      );

      let resolveState: (() => void) | undefined;
      const statePublished = new Promise<void>((resolve) => {
        resolveState = resolve;
      });
      handleTaskEvent(
        {
          store,
          publish: (type) => {
            if (type === "state") resolveState?.();
          },
          launchingTask: () => undefined,
          openingOperation: async (_key, action) => action(),
          generatePreparedAutofill: async () => ({ id: "unused" }),
        },
        {
          method: "turn/completed",
          threadId,
          params: { turn: { id: turnId, status: "completed", items: [] } },
        },
      );
      assert.equal(store.get("task", id)?.documentResult?.status, "rendering");
      assert.equal(store.get("task", id)?.documentResult?.turnId, turnId);
      store.remove("bundle", id);

      await statePublished;
      const result = store.get("task", id)?.documentResult;
      assert.equal(result?.status, "failed");
      assert.equal(result?.turnId, turnId);
      assert.match(
        result?.error ?? "",
        /bundle was removed during PDF generation/,
      );
    }),
);

for (const priorStatus of ["ready", "failed"]) {
  test(`pre-render failure does not reuse a prior ${priorStatus} turn`, async () =>
    withStore("task-pre-render-", async (store) => {
      const id = randomUUID();
      const threadId = "document-thread";
      const turnId = "current-turn";
      store.put(
        "task",
        id,
        legacyTask({
          id,
          preset: "posting-cover-letter",
          status: "running",
          threadId,
          documentResult: { status: priorStatus, turnId: "prior-turn" },
        }),
      );
      let resolveState: (() => void) | undefined;
      const statePublished = new Promise<void>((resolve) => {
        resolveState = resolve;
      });
      handleTaskEvent(
        {
          store,
          publish: (type) => {
            if (type === "state") resolveState?.();
          },
          launchingTask: () => undefined,
          openingOperation: async (_key, action) => action(),
          generatePreparedAutofill: async () => ({ id: "unused" }),
        },
        {
          method: "turn/completed",
          threadId,
          params: { turn: { id: turnId, status: "completed", items: [] } },
        },
      );
      await statePublished;
      const result = store.get("task", id)?.documentResult;
      assert.equal(result?.status, "failed");
      assert.equal(result?.turnId, turnId);
      assert.equal(
        result?.error,
        process.platform === "darwin"
          ? "Error: The task draft bundle is missing. Restore it before generating PDFs."
          : "Error: The trusted PDF renderers require macOS",
      );
    }));
}

test("preparation document creation reports 409 when its opening is missing", async () =>
  withRuntime("task-preparation-", async (runtime) => {
    const run = {
      id: "preparation",
      openingId: "removed-opening",
      applicationId: "application",
      status: "running",
      phase: "documents",
      message: "Preparing documents",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      openingHash: "opening-hash",
      documentIds: [],
      taskIds: [],
      supportedForm: false,
    } satisfies Records["application_preparation"];
    await assert.rejects(
      runtime.createPreparationDocuments(run, "posting-cover-letter"),
      (error: unknown) => {
        assert.ok(error instanceof MissingRecordError);
        assert.equal(error.status, 409);
        assert.equal(error.kind, "opening");
        assert.equal(error.id, run.openingId);
        assert.equal(error.message, "Opening was removed during preparation");
        return true;
      },
    );
    assert.equal(runtime.store.list("task").length, 0);
  }));
