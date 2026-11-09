import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { applicationAnswerFixture } from "../fixtures/application-answers-fixture.js";
import { legacyTask } from "../fixtures/legacy-records.js";
import { atomicWrite, sha256 } from "../../server/storage.js";
import { draftPath } from "../../server/bundles.js";
import { applicationEvidencePaths } from "../../server/application-evidence.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";
import { abortGenerations } from "../../server/generation-control.js";

test(
  "cancelling a live PDF renderer never registers a finished document",
  { skip: process.platform !== "darwin" },
  async () => {
    const f = applicationAnswerFixture();
    try {
      const id = randomUUID();
      const paths = [...applicationEvidencePaths];
      const hashes = Object.fromEntries(
        paths.map((p) => [p, sha256(readFileSync(path.join(f.root, p)))]),
      );
      for (const file of paths)
        atomicWrite(
          draftPath(f.store, id, file),
          readFileSync(path.join(f.root, file)),
        );
      atomicWrite(
        draftPath(f.store, id, "cover_letter.txt"),
        "Dear team,\n\nThis is a controlled rendering cancellation fixture. No application is being sent.\n\nThank you.",
      );
      f.store.put("bundle", id, {
        id,
        version: 1,
        scope: "posting-draft",
        paths,
        sourceHashes: hashes,
      });
      f.store.put(
        "task",
        id,
        legacyTask({
          id,
          preset: "posting-cover-letter",
          status: "completed",
          context: { openingId: "one" },
          posting: {
            title: "Fixture",
            hash: "posting",
            url: f.store.opening("one")?.url,
          },
        }),
      );
      const rendering = renderApplicationDocuments(f.store, id, "turn");
      await abortGenerations(f.store);
      const result = await rendering;
      assert.equal(result.status, "failed");
      assert.match(result.error || "", /Reload app/);
      assert.equal(f.store.list("generated_document").length, 0);
      assert.equal(f.store.get("task", id)?.documentResult?.status, "failed");
    } finally {
      f.cleanup();
    }
  },
);
