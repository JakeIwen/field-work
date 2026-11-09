import test from "node:test";
import assert from "node:assert/strict";
import { overflowPreparationFixture } from "../fixtures/overflow-preparation.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";

const native = { skip: process.platform !== "darwin", timeout: 60000 };
test(
  "bounded overflow recovery follows up once, validates the PDF and publishes no duplicate",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t);
    try {
      f.manager.start("one", "resume");
      for (let i = 0; i < 10; i++) await f.manager.tick();
      assert.equal(f.followups.length, 1, f.manager.latest("one")?.error);
      assert.match(f.followups[0], /Page 2.*1\.12/);
      assert.match(f.followups[0], /required content/);
      assert.match(f.followups[0], /fonts.*margins/);
      assert.match(
        f.followups[0],
        /removing 1 full line[\s\S]*"Owned a production Rails insurance portal": 4 lines, last line 10 characters/,
      );
      const run = f.manager.latest("one");
      assert.equal(run?.status, "ready", run?.error);
      assert.ok(run?.documentTaskId);
      const task = f.store.get("task", run.documentTaskId);
      assert.equal(task?.documentResult?.validation?.status, "passed");
      assert.equal(f.store.list("generated_document").length, 3);
      await renderApplicationDocuments(
        f.store,
        run.documentTaskId,
        "revision-1",
      );
      assert.equal(f.store.list("generated_document").length, 3);
      assert.equal(run.documentIds[1], f.original[1]);
      const manual = await f.workspace.post(
        `/api/tasks/${run.documentTaskId}/message`,
        { prompt: "Explicit later revision", clientRequestId: "manual-later" },
      );
      assert.equal(manual.status, 200);
      assert.equal(
        f.store.get("task", run.documentTaskId)?.documentResult?.status,
        "ready",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "overflow recovery stops after two attempts and retains the measured failure",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t, 99);
    try {
      f.manager.start("one", "resume");
      for (let i = 0; i < 12; i++) await f.manager.tick();
      assert.equal(f.followups.length, 2);
      assert.equal(f.manager.latest("one")?.status, "failed");
      assert.match(
        f.manager.latest("one")?.error ?? "",
        /Page 2 overflowed by 1\.12 points/,
      );
      assert.match(f.manager.latest("one")?.error ?? "", /2.*attempts/);
      assert.equal(f.store.list("generated_document").length, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "overflow follow-up retains source-hash conflicts instead of starting a turn",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t);
    try {
      f.manager.start("one", "resume");
      await f.manager.tick();
      await f.manager.tick();
      const taskId = f.manager.latest("one")?.documentTaskId;
      assert.ok(taskId);
      const bundle = f.store.get("bundle", taskId);
      assert.ok(bundle);
      f.store.put("bundle", taskId, {
        ...bundle,
        sourceHashes: {
          ...bundle.sourceHashes,
          "source_data/resume.md": "conflicting-source-hash",
        },
      });
      await f.manager.tick();
      assert.equal(f.followups.length, 0);
      assert.match(
        f.manager.latest("one")?.error ?? "",
        /Original sources changed/,
      );
    } finally {
      await f.close();
    }
  },
);

for (const action of [
  "interrupt",
  "delete-preparation",
  "delete-task",
  "delete-opening",
  "delete-application",
] as const) {
  test(
    `overflow follow-up cannot publish after ${action}`,
    native,
    async (t) => {
      const f = await overflowPreparationFixture(t);
      try {
        const run = f.manager.start("one", "resume");
        assert.ok(run.applicationId);
        const applicationId = run.applicationId;
        f.beforeFollowup(async () => {
          const current = f.manager.latest("one");
          assert.ok(current?.documentTaskId);
          if (action === "delete-preparation")
            f.store.remove("application_preparation", run.id);
          else if (action === "delete-task")
            f.store.remove("task", current.documentTaskId);
          else if (action === "delete-opening")
            f.store.remove("cache_opening", run.openingId);
          else if (action === "delete-application")
            f.store.remove("application", applicationId);
          else {
            const response = await f.workspace.post(
              `/api/tasks/${current.documentTaskId}/interrupt`,
            );
            assert.equal(response.status, 200);
          }
        });
        for (let i = 0; i < 10; i++) await f.manager.tick();
        assert.equal(f.followups.length, 1, f.manager.latest("one")?.error);
        assert.equal(f.store.list("generated_document").length, 2);
        assert.notEqual(f.manager.latest("one")?.status, "ready");
        if (action === "interrupt") {
          f.beforeFollowup(async () => {});
          const taskId = f.manager.latest("one")?.documentTaskId;
          assert.ok(taskId);
          assert.equal(
            (
              await f.workspace.post(`/api/tasks/${taskId}/message`, {
                prompt: "Explicit retry",
                clientRequestId: "manual-retry",
              })
            ).status,
            200,
          );
          assert.equal(
            f.store.get("task", taskId)?.documentResult?.status,
            "ready",
          );
          await assert.rejects(
            renderApplicationDocuments(f.store, taskId, "revision-1"),
            /cancelled/,
          );
          assert.equal(f.store.list("generated_document").length, 3);
        }
        if (action === "delete-preparation")
          assert.equal(
            f.store.get("application_preparation", run.id),
            undefined,
          );
      } finally {
        await f.close();
      }
    },
  );
}
