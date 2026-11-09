import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { copySampleWorkspace } from "../fixtures/sample-workspace.js";
import { atomicWrite } from "../../server/storage.js";
import { applicationEvidencePaths } from "../../server/application-evidence.js";
import { documentWritingWarning } from "../../server/document-writing-status.js";
import { overflowPreparationFixture } from "../fixtures/overflow-preparation.js";

for (const change of [
  "opening",
  "resume",
  "dossier",
  "writing-rules",
] as const) {
  test(
    `repair publication rechecks ${change} after awaited native validation`,
    { skip: process.platform !== "darwin", timeout: 90000 },
    async (t) => {
      const root = copySampleWorkspace(t);
      const f = await overflowPreparationFixture(t, 1, root);
      let release = () => {};
      let tick: Promise<void> | undefined;
      try {
        const run = f.manager.start("one", "resume");
        assert.ok(run.applicationId);
        await f.manager.tick();
        await f.manager.tick();
        const before = f.store.get(
          "application",
          run.applicationId,
        )?.documentIds;
        const barrier = f.holdValidation();
        release = barrier.release;
        tick = f.manager.tick();
        await barrier.started;
        if (change === "opening") {
          const opening = f.store.get("cache_opening", "one");
          assert.ok(opening);
          f.store.put("cache_opening", "one", {
            ...opening,
            title: "Changed role during validation",
          });
        } else {
          const file = path.join(
            root,
            change === "writing-rules"
              ? "AGENTS.md"
              : applicationEvidencePaths[change === "resume" ? 0 : 1],
          );
          const text = readFileSync(file, "utf8");
          atomicWrite(
            file,
            change === "writing-rules"
              ? text.replace(
                  "# Job Search Writing Guidelines",
                  "# Job Search Writing Guidelines\nUse a newly revised shared editorial policy.",
                )
              : text + "\nChanged authoritative evidence during validation.\n",
          );
        }
        release();
        await tick;
        const taskId = f.manager.latest("one")?.documentTaskId;
        assert.ok(taskId);
        const result = f.store.get("task", taskId)?.documentResult;
        if (change === "writing-rules") {
          assert.equal(result?.status, "ready", result?.error);
          const doc = f.store.document(result?.documentIds?.[0] ?? "");
          assert.ok(doc);
          assert.match(
            documentWritingWarning(f.store, doc) ?? "",
            /writing rules changed/,
          );
        } else {
          assert.equal(
            f.store.list("generated_document").length,
            2,
            "stale repair must not register a document",
          );
          assert.deepEqual(
            f.store.get("application", run.applicationId)?.documentIds,
            before,
          );
          assert.equal(result?.status, "failed");
          assert.match(result?.error ?? "", /changed/);
        }
      } finally {
        release();
        await tick;
        await f.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
