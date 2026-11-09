import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { draftPath } from "../server/bundles.js";
import { contextTool } from "../server/context-tools.js";
import {
  atomicWrite,
  MissingRecordError,
  sha256,
  Store,
} from "../server/storage.js";
import type { Task } from "../shared/task-records.js";

for (const preset of [
  "posting-cover-letter",
  "posting-resume",
  "posting-application",
] as const) {
  test(`${preset} source tool rejects a missing bundle without changing draft bytes`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "missing-tool-bundle-"));
    const store = new Store(root, path.join(root, "data"));
    try {
      const task: Task = {
        id: randomUUID(),
        preset,
        status: "running",
        version: 1,
        threadId: "document-thread",
        prompt: "Revise the captured draft",
        context: {},
        messages: [],
        eventCount: 0,
      };
      store.put("task", task.id, task);
      const relative =
        preset === "posting-cover-letter"
          ? "cover_letter.txt"
          : "source_master_template/v12/resume.md";
      const source = draftPath(store, task.id, relative);
      atomicWrite(source, "Original draft");
      const args = {
        path: relative,
        expectedHash: sha256("Original draft"),
        content: "Revised draft",
      };
      assert.throws(
        () =>
          contextTool(
            store,
            "document-thread",
            "write_application_source",
            args,
          ),
        (error: unknown) => {
          assert.ok(error instanceof MissingRecordError);
          assert.equal(error.status, 409);
          assert.equal(error.kind, "bundle");
          assert.equal(error.id, task.id);
          assert.equal(
            error.message,
            "This conversation's draft bundle is missing.",
          );
          return true;
        },
      );
      assert.equal(readFileSync(source, "utf8"), "Original draft");
      assert.deepEqual(store.get("task", task.id), task);
      assert.equal(store.get("bundle", task.id), undefined);
      assert.equal(
        existsSync(draftPath(store, task.id, "source-history")),
        false,
      );

      // The same request succeeds once its dependency is restored: the missing
      // bundle, not an invalid tool/path/hash/status, caused the rejection.
      store.put("bundle", task.id, {
        id: task.id,
        version: 1,
        sourceHashes: {},
        paths: [relative],
        versionDir: "source_master_template/v12",
        master: "source_master_template/v12/resume.md",
      });
      const result = contextTool(
        store,
        "document-thread",
        "write_application_source",
        args,
      );
      assert.equal(result.hash, sha256("Revised draft"));
      assert.equal(readFileSync(source, "utf8"), "Revised draft");
      assert.equal(store.get("bundle", task.id)?.version, 2);
      assert.equal(
        readFileSync(
          draftPath(
            store,
            task.id,
            `source-history/${sha256(relative)}/${sha256(args.content)}.txt`,
          ),
          "utf8",
        ),
        args.content,
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
