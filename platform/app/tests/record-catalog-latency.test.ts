import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWrite, type Store } from "../server/storage.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function seedMeasurement(store: Store) {
  store.db.exec("DELETE FROM records WHERE kind!='settings'; BEGIN");
  const insert = store.db.prepare(
    "INSERT INTO records(kind,id,json) VALUES(?,?,?)",
  );
  const put = (kind: string, id: string, fields: Record<string, unknown>) =>
    insert.run(
      kind,
      id,
      JSON.stringify({ id, createdAt: "2026-01-01T00:00:00.000Z", ...fields }),
    );
  for (let i = 0; i < 1000; i++)
    put("task", `task-${i}`, {
      title: "Research job posting",
      preset: "opening-research",
      status: "completed",
      context: { openingId: `opening-${i % 300}` },
      prompt: "P".repeat(128 * 1024),
      messages: [{ text: "M".repeat(64 * 1024) }],
    });
  for (let i = 0; i < 300; i++)
    put("cache_opening", `opening-${i}`, {
      title: `Engineer ${i}`,
      company: "Synthetic Company",
      requirements: "R".repeat(20 * 1024),
    });
  for (let i = 0; i < 300; i++)
    put("cache_document", `document-${i}`, {
      name: `resume-${i}.pdf`,
      text: "D".repeat(20 * 1024),
    });
  for (let i = 0; i < 100; i++)
    put("application", `application-${i}`, {
      openingId: `opening-${i}`,
      packages: [
        { documents: [{ id: `document-${i}`, bytes: "B".repeat(20 * 1024) }] },
      ],
    });
  for (let i = 0; i < 104; i++)
    put("application_preparation", `preparation-${i}`, {
      openingId: `opening-${i}`,
      applicationId: `application-${i % 100}`,
      status: "ready",
      documentIds: [`document-${i}`],
    });
  for (let i = 0; i < 16; i++)
    put("greenhouse_pull_run", `pull-${i}`, {
      status: "target_reached",
      target: 10,
    });
  for (let i = 0; i < 480; i++)
    put("greenhouse_pull_candidate", `candidate-${i}`, {
      runId: `pull-${i % 16}`,
      state: i % 2 ? "added" : "excluded",
      posting: { text: "C".repeat(20 * 1024) },
    });
  for (let i = 0; i < 2700; i++)
    put("journal", `journal-${i}`, {
      at: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
      entityId: `opening-${i % 300}`,
      type: i % 2 ? "autofill_fetch" : "task_created",
      message: `Synthetic event ${i}`,
      details: { outcome: "success", note: "J".repeat(2048) },
    });
  store.db.exec("COMMIT");
}

test(
  "catalog endpoint latency on a live-sized synthetic store",
  {
    skip:
      process.env.FIELDWORK_RECORD_LATENCY !== "1" &&
      "Opt-in 200 MiB SQLite measurement: set FIELDWORK_RECORD_LATENCY=1",
  },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "catalog-latency-"));
    atomicWrite(path.join(root, "AGENTS.md"), "Synthetic measurement fixture");
    atomicWrite(path.join(root, "README.md"), "Synthetic measurement fixture");
    const workspace = await openFixtureWorkspace(root);
    try {
      seedMeasurement(workspace.store);
      t.diagnostic(
        "Synthetic store: 5,000 records (1,000 tasks at ~192 KiB each; 2,700 journal entries; 16 pulls and 480 candidates)",
      );
      for (const [name, route] of [
        ["list", "/api/records?limit=50"],
        ["detail", "/api/records/application/application-1"],
        ["activity", "/api/activity?limit=50"],
      ]) {
        const timings: number[] = [];
        let bytes = 0;
        for (let index = 0; index < 3; index++) {
          const start = performance.now();
          const response = await workspace.get(route);
          const body = await response.text();
          assert.equal(response.status, 200, body);
          bytes = Buffer.byteLength(body);
          timings.push(performance.now() - start);
        }
        t.diagnostic(
          `${name}: ${timings.map((ms) => ms.toFixed(1)).join(", ")} ms; ${bytes.toLocaleString("en-US")} response bytes`,
        );
      }
    } finally {
      await workspace.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
