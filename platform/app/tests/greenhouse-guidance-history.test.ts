import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, sha256 } from "../server/storage.js";
import { migrateGreenhouseGuidanceHistory } from "../server/storage-migrations.js";
import {
  deleteGreenhouseGuidanceHistory,
  greenhouseGuidanceHistory,
  rememberGreenhouseGuidance,
} from "../server/opening-pull/guidance-history.js";
import { greenhouseGuidanceHistoryLimit } from "../shared/greenhouse-guidance.js";
import { fixture, at } from "./fixtures/greenhouse-pull-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const guidance = {
  instructions: "Check hours.\nPreserve hourly pay.",
  searchTerms: [],
};
const historyRoute = "/api/greenhouse/guidance/history";

test("history normalizes text, upserts use dates, skips blanks and evicts oldest use", async () => {
  const f = fixture();
  try {
    const first = new Date(at).toISOString();
    const later = new Date(at + 1000).toISOString();
    rememberGreenhouseGuidance(
      f.store,
      "  Check hours.\r\nPreserve hourly pay. ",
      first,
    );
    rememberGreenhouseGuidance(f.store, guidance.instructions, later);
    rememberGreenhouseGuidance(f.store, " \r\n ", later);
    assert.deepEqual(greenhouseGuidanceHistory(f.store), [
      {
        id: sha256(guidance.instructions),
        instructions: guidance.instructions,
        createdAt: first,
        lastUsedAt: later,
      },
    ]);
    for (let index = 0; index < greenhouseGuidanceHistoryLimit; index++)
      rememberGreenhouseGuidance(
        f.store,
        `Instructions ${index}`,
        new Date(at + 2000 + index).toISOString(),
      );
    const entries = greenhouseGuidanceHistory(f.store);
    assert.equal(entries.length, greenhouseGuidanceHistoryLimit);
    assert.equal(
      entries[0].instructions,
      `Instructions ${greenhouseGuidanceHistoryLimit - 1}`,
    );
    assert.equal(
      entries.some((entry) => entry.instructions === guidance.instructions),
      false,
    );
  } finally {
    await f.close();
  }
});

test("starting a pull records captured instructions once and refreshes their last use", async () => {
  const f = fixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: guidance,
    });
    const run = f.manager.start(1, "history-start");
    const first = greenhouseGuidanceHistory(f.store)[0];
    assert.equal(first.instructions, guidance.instructions);
    assert.equal(first.createdAt, run.createdAt);
    f.setTime(at + 1000);
    assert.equal(f.manager.start(1, "history-start").id, run.id);
    assert.deepEqual(greenhouseGuidanceHistory(f.store), [first]);
    f.manager.action(run.id, "stop");
    const next = f.manager.start(1, "history-next");
    assert.deepEqual(greenhouseGuidanceHistory(f.store), [
      { ...first, lastUsedAt: next.createdAt },
    ]);
    const runs = f.store.list("greenhouse_pull_run");
    const settings = f.store.settings();
    deleteGreenhouseGuidanceHistory(f.store, first.id);
    assert.deepEqual(f.store.list("greenhouse_pull_run"), runs);
    assert.deepEqual(f.store.settings(), settings);
  } finally {
    await f.close();
  }
});

test("migration 6 seeds every instruction snapshot and saved settings without rewriting runs", async () => {
  const f = fixture();
  try {
    const base = f.manager.start();
    const earliest = "2026-09-01T00:00:00.000Z";
    const latest = "2026-10-01T00:00:00.000Z";
    const legacy = { ...guidance, throughDate: "2026-09-28" };
    for (const [id, createdAt, instructions] of [
      ["first", earliest, " Check hours.\r\nPreserve hourly pay. "],
      ["last", latest, guidance.instructions],
      ["original", earliest, "Original instructions"],
    ])
      f.store.put("greenhouse_pull_run", id, {
        ...base,
        id,
        createdAt,
        guidance: { ...legacy, instructions },
      });
    const settings = f.store.put("settings", "main", {
      ...f.store.settings(),
      updatedAt: latest,
      greenhouseGuidance: legacy,
    });
    const runs = f.store.list("greenhouse_pull_run");
    f.store.db.prepare("DELETE FROM migrations WHERE version=6").run();
    assert.equal(migrateGreenhouseGuidanceHistory(f.store), true);
    const entries = greenhouseGuidanceHistory(f.store);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      id: sha256(guidance.instructions),
      instructions: guidance.instructions,
      createdAt: earliest,
      lastUsedAt: latest,
    });
    assert.equal(entries[1].instructions, "Original instructions");
    assert.equal(f.store.settings().version, settings.version + 1);
    assert.deepEqual(f.store.settings().greenhouseGuidance, guidance);
    assert.deepEqual(f.store.list("greenhouse_pull_run"), runs);
    assert.equal(migrateGreenhouseGuidanceHistory(f.store), false);
    assert.deepEqual(greenhouseGuidanceHistory(f.store), entries);
    assert.equal(f.store.settings().version, settings.version + 1);
  } finally {
    await f.close();
  }
});

test("Store startup runs migration 6 once and deletion is not resurrected on restart", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "guidance-startup-"));
  const data = path.join(root, "data");
  let store = new Store(root, data);
  try {
    const legacy = { ...guidance, throughDate: "2026-09-28" };
    store.put("settings", "main", {
      ...store.settings(),
      greenhouseGuidance: legacy,
    });
    store.db.prepare("DELETE FROM migrations WHERE version=6").run();
    store.close();
    store = new Store(root, data);
    const entry = greenhouseGuidanceHistory(store)[0];
    assert.equal(entry.instructions, guidance.instructions);
    assert.deepEqual(store.settings().greenhouseGuidance, guidance);
    store.remove("greenhouse_guidance_history", entry.id);
    store.close();
    store = new Store(root, data);
    assert.deepEqual(greenhouseGuidanceHistory(store), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("history API saves and reuses text, orders uses, exports and deletes only history", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "guidance-history-api-"));
  const http = await openFixtureWorkspace(root);
  try {
    const old = "2026-09-01T00:00:00.000Z";
    const first = rememberGreenhouseGuidance(
      http.store,
      guidance.instructions,
      old,
    );
    assert.ok(first);
    const second = rememberGreenhouseGuidance(
      http.store,
      "Other instructions",
      "2026-09-02T00:00:00.000Z",
    );
    assert.ok(second);
    const save = () =>
      http.post("/api/greenhouse/guidance", {
        expectedVersion: http.store.settings().version,
        guidance: {
          ...guidance,
          employmentScope: ["full_time"],
          instructions: "  Check hours.\r\nPreserve hourly pay. ",
        },
      });
    assert.equal((await save()).status, 200);
    let entries = await (await http.get(historyRoute)).json();
    assert.deepEqual(
      entries.map((entry: { id: string }) => entry.id),
      [first.id, second.id],
    );
    assert.equal(entries[0].createdAt, old);
    assert.ok(entries[0].lastUsedAt > old);
    assert.equal((await save()).status, 200);
    entries = await (await http.get(historyRoute)).json();
    assert.equal(entries.length, 2);
    assert.deepEqual(
      http.store
        .personalExport()
        .records.greenhouse_guidance_history.sort((a, b) =>
          b.lastUsedAt.localeCompare(a.lastUsedAt),
        ),
      entries,
    );
    const settings = http.store.settings();
    const response = await http.post(
      `${historyRoute}/${first.id}`,
      {},
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    assert.deepEqual(http.store.settings(), settings);
    assert.equal(
      (await http.post(`${historyRoute}/${first.id}`, {}, "DELETE")).status,
      404,
    );
    assert.deepEqual(
      (await (await http.get(historyRoute)).json()).map(
        (entry: { id: string }) => entry.id,
      ),
      [second.id],
    );
    assert.equal(
      (await save()).status,
      200,
      "saving deleted text adds it again",
    );
    assert.equal((await (await http.get(historyRoute)).json()).length, 2);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});
