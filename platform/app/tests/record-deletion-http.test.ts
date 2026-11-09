import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWrite, sha256 } from "../server/storage.js";
import { journalDeletionMaxIds } from "../shared/activity.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { GmailManager } from "../server/gmail/manager.js";
import { newGreenhousePullRun } from "../server/greenhouse-pull-start.js";
import { legacyApplication, legacyTask } from "./fixtures/legacy-records.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deletion-http-"));
  for (const dir of [
    "source_data",
    "source_master_template",
    "employer_specific",
    "old_resume",
  ])
    mkdirSync(path.join(root, dir));
  atomicWrite(
    path.join(root, "company_careers/companies.md"),
    "# Companies\n## Fixture\n<!-- company_id: fixture -->\n- **Careers URL:** https://example.com/careers\n",
  );
  atomicWrite(
    path.join(root, "company_careers/current_openings.md"),
    "# Openings\nNo qualifying current openings.\n",
  );
  const workspace = await openFixtureWorkspace(root);
  t.after(async () => {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  });
  return workspace;
}

const journal = (id: string) => ({
  id,
  at: "2026-10-30T12:00:00Z",
  type: "note",
  message: id,
});

test("bulk journal deletion validates, deduplicates, counts missing IDs and emits state without reindex", async (t) => {
  const f = await fixture(t);
  for (const body of [
    null,
    [],
    {},
    { ids: "one" },
    { ids: [] },
    { ids: [1] },
    { ids: [" "] },
    { ids: Array(journalDeletionMaxIds + 1).fill("one") },
  ]) {
    const response = await f.post("/api/journal", body, "DELETE");
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  f.store.put("journal", "one", journal("one"));
  f.store.put("journal", "two", journal("two"));
  f.store.put("journal", "keep", journal("keep"));
  f.store.put("task", "busy", legacyTask({ id: "busy", status: "running" }));
  const imported = f.store.get("meta", "import");
  const events = await f.get("/api/events"),
    reader = events.body?.getReader();
  assert.ok(reader);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /connected/,
  );
  try {
    const response = await f.post(
      "/api/journal",
      { ids: ["one", "two", "one", "missing", "missing"] },
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: 2, missing: 1 });
    assert.equal(f.store.get("journal", "one"), undefined);
    assert.ok(f.store.get("journal", "keep"));
    assert.ok(f.store.get("deleted_record", sha256("journal:one")));
    assert.deepEqual(f.store.get("meta", "import"), imported);
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /"type":"state"/,
    );
  } finally {
    await reader.cancel();
  }
});

test("a failed bulk journal transaction retains every row", async (t) => {
  const f = await fixture(t);
  for (const id of ["one", "two"]) f.store.put("journal", id, journal(id));
  f.store.db.exec(
    "CREATE TRIGGER fail_second_journal BEFORE DELETE ON records WHEN OLD.kind='journal' AND OLD.id='two' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
  );
  const response = await f.post(
    "/api/journal",
    { ids: ["one", "two"] },
    "DELETE",
  );
  assert.equal(response.status, 500);
  assert.ok(f.store.get("journal", "one"));
  assert.ok(f.store.get("journal", "two"));
  assert.equal(f.store.get("deleted_record", sha256("journal:one")), undefined);
});

test("single leaf deletion ignores background work while heavy deletion names Greenhouse finishing and cooldown", async (t) => {
  const f = await fixture(t);
  f.store.put(
    "application",
    "application",
    legacyApplication({ id: "application" }),
  );
  const preview = await (
    await f.get("/api/records/application/application/deletion")
  ).json();
  const run = newGreenhousePullRun(
    f.store,
    1,
    "fixture",
    undefined,
    Date.now(),
  );
  for (const status of ["cooldown", "finishing", "stopped"] as const) {
    f.store.put("greenhouse_pull_run", "pull", {
      ...run,
      id: "pull",
      status,
      finishReviews: true,
    });
    const blocked = await f.post(
      "/api/records/application/application",
      { token: preview.token },
      "DELETE",
    );
    assert.equal(blocked.status, 409, await blocked.clone().text());
    assert.match((await blocked.json()).error, /Greenhouse/);
    f.store.put("journal", status, journal(status));
    const leaf = await (
      await f.get(`/api/records/journal/${status}/deletion`)
    ).json();
    const deleted = await f.post(
      `/api/records/journal/${status}`,
      { token: leaf.token },
      "DELETE",
    );
    assert.equal(deleted.status, 200);
  }
  f.store.remove("greenhouse_pull_run", "pull");
});

test("heavy deletion names an active Gmail check while leaf deletion proceeds", async (t) => {
  const f = await fixture(t);
  f.store.put(
    "application",
    "application",
    legacyApplication({ id: "application" }),
  );
  const preview = await (
    await f.get("/api/records/application/application/deletion")
  ).json();
  const gmail = t.mock.getter(GmailManager.prototype, "active", () => true);
  try {
    const response = await f.post(
      "/api/records/application/application",
      { token: preview.token },
      "DELETE",
    );
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Employer replies/);
    f.store.put("journal", "entry", journal("entry"));
    assert.equal(
      (await f.post("/api/journal", { ids: ["entry"] }, "DELETE")).status,
      200,
    );
  } finally {
    gmail.mock.restore();
  }
});

test("HTTP deletion skips personal-only reindex but reconciles changed imported sources", async (t) => {
  const f = await fixture(t);
  f.store.put(
    "application",
    "application",
    legacyApplication({ id: "application" }),
  );
  const imported = f.store.get("meta", "import");
  const preview = await (
    await f.get("/api/records/application/application/deletion")
  ).json();
  assert.equal(
    (
      await f.post(
        "/api/records/application/application",
        { token: preview.token },
        "DELETE",
      )
    ).status,
    200,
  );
  assert.deepEqual(f.store.get("meta", "import"), imported);
  const companyPreview = await (
    await f.get("/api/records/company/fixture/deletion")
  ).json();
  const response = await f.post(
    "/api/records/company/fixture",
    { token: companyPreview.token },
    "DELETE",
  );
  assert.equal(response.status, 200);
  assert.notEqual(
    f.store.get("meta", "import")?.importedAt,
    imported?.importedAt,
  );
  assert.equal(f.store.get("cache_company", "fixture"), undefined);
});
