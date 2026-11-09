import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { atomicWrite, type Store } from "../server/storage.js";
import type { CatalogPage, RecordDetail } from "../shared/record-catalog.js";
import type { ActivityPage } from "../shared/activity.js";
import { tunables } from "../shared/tunables.js";

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "record-catalog-"));
  atomicWrite(path.join(root, "AGENTS.md"), "Synthetic test workspace");
  atomicWrite(path.join(root, "README.md"), "Synthetic test workspace");
  const workspace = await openFixtureWorkspace(root);
  workspace.store.db
    .prepare("DELETE FROM records WHERE kind!='settings'")
    .run();
  return {
    ...workspace,
    cleanup: async () => {
      await workspace.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function seed(
  store: Store,
  kind: string,
  id: string,
  value: Record<string, unknown> = {},
) {
  store.db
    .prepare("INSERT OR REPLACE INTO records(kind,id,json) VALUES(?,?,?)")
    .run(kind, id, JSON.stringify({ id, ...value }));
}
async function json<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  route: string,
): Promise<T> {
  const response = await f.get(route);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function seedCatalog(store: Store) {
  seed(store, "cache_opening", "opening", {
    title: "Platform Engineer",
    company: "Acme",
    firstImportedAt: "2026-01-02",
    first_published: "2020-01-01",
  });
  seed(store, "custom_opening", "opening", { title: "Shadow opening" });
  seed(store, "cache_company", "company", {
    name: "Acme",
    addedAt: "2026-01-01",
  });
  seed(store, "custom_company", "company", { name: "Shadow company" });
  seed(store, "cache_document", "document", {
    name: "resume.pdf",
    firstImportedAt: "2026-01-03",
  });
  seed(store, "generated_document", "document", { name: "shadow.pdf" });
  seed(store, "application", "application", {
    openingId: "opening",
    createdAt: "2026-01-04",
    status: "applied",
    packages: [{ huge: "x".repeat(100_000) }],
  });
  seed(store, "task", "task", {
    title: "Research job posting",
    context: { openingId: "opening" },
    preset: "opening-research",
    status: "completed",
    createdAt: "2026-01-05",
    prompt: "x".repeat(100_000),
  });
  seed(store, "journal", "journal", {
    at: "2026-01-06",
    type: "task_created",
    message: "Not in saved records",
  });
  seed(store, "saved_filter", "filter", { name: "Not in saved records" });
}

test("catalog titles, dates, storage-family precedence, search and counts use projected records", async () => {
  const f = await fixture();
  try {
    seedCatalog(f.store);
    const page = await json<CatalogPage>(f, "/api/records");
    assert.equal(page.total, 5);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      ["task", "application", "document", "opening", "company"],
    );
    const application = page.rows.find((row) => row.id === "application");
    assert.equal(application?.title, "Platform Engineer");
    assert.equal(application?.subtitle, "Acme");
    assert.equal(application?.atLabel, "Created");
    assert.ok((application?.bytes ?? 0) > 100_000);
    assert.equal(
      page.rows.find((row) => row.id === "opening")?.at,
      "2026-01-02",
    );
    assert.equal(
      page.rows.find((row) => row.id === "opening")?.atLabel,
      "Added",
    );
    assert.equal(
      page.rows.find((row) => row.id === "company")?.atLabel,
      "Added",
    );
    assert.match(
      page.rows[0].subtitle ?? "",
      /Research a posting URL.*completed.*Acme · Platform Engineer/,
    );
    const search = await json<CatalogPage>(
      f,
      "/api/records?kind=application&q=aCmE",
    );
    assert.equal(search.total, 1);
    assert.deepEqual(search.counts, {
      application: 1,
      company: 1,
      opening: 1,
      task: 1,
    });
    assert.equal(
      (await json<CatalogPage>(f, "/api/records?q=shadow")).total,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("cursor pages have no gaps, including tied dates, missing dates and identical ids across kinds", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 9; index++)
      seed(f.store, "application", `a${index}`, {
        title: `Application ${index}`,
        createdAt: index < 6 ? "2026-01-01" : undefined,
      });
    seed(f.store, "task", "a0", { title: "Same id", createdAt: "2026-01-01" });
    for (const sort of ["newest", "oldest"]) {
      const expected = (
        await json<CatalogPage>(f, `/api/records?sort=${sort}`)
      ).rows.map((row) => `${row.kind}:${row.id}`);
      const actual: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await json<CatalogPage>(
          f,
          `/api/records?sort=${sort}&limit=3${cursor ? `&cursor=${cursor}` : ""}`,
        );
        actual.push(...page.rows.map((row) => `${row.kind}:${row.id}`));
        assert.equal(page.total, 10);
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(actual, expected);
      assert.equal(new Set(actual).size, 10);
    }
    for (const route of [
      "/api/records?kind=nope",
      "/api/records?sort=wrong",
      "/api/records?limit=0",
      `/api/records?limit=${tunables["records.catalogPageSize"].max + 1}`,
      "/api/records?cursor=wrong",
      "/api/activity?level=wrong",
      `/api/activity?limit=${tunables["records.activityPageSize"].max + 1}`,
    ])
      assert.equal((await f.get(route)).status, 400, route);
    for (const route of [
      "/api/records/nope/id",
      "/api/records/task/missing",
      "/api/records/journal/id",
    ])
      assert.equal((await f.get(route)).status, 404, route);
  } finally {
    await f.cleanup();
  }
});

function seedDetail(store: Store) {
  seed(store, "cache_opening", "opening", {
    title: "Engineer",
    company: "Acme",
    requirements: "PRIVATE POSTING".repeat(20_000),
  });
  seed(store, "application", "application", {
    openingId: "opening",
    createdAt: "2026-01-01",
    version: 3,
    documentIds: ["document"],
    packages: [{ scriptId: "script", documents: [{ id: "document" }] }],
    notes: "N".repeat(3000),
    many: Array(100).fill("large"),
    nested: { pdfBase64: "SECRET PDF".repeat(100_000) },
    other: Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [i, "😀".repeat(1900)]),
    ),
  });
  seed(store, "generated_document", "document", {
    name: "resume.pdf",
    applicationId: "application",
  });
  seed(store, "application_autofill", "script", {
    openingId: "opening",
    script: "SECRET SCRIPT".repeat(100_000),
  });
  seed(store, "application_preparation", "preparation", {
    applicationId: "application",
    openingId: "opening",
    taskIds: ["task"],
    scriptId: "script",
  });
  seed(store, "task", "task", {
    title: "Draft resume",
    context: { openingId: "opening" },
    eventCount: 10000,
    thread: { secret: "NO TRANSCRIPT" },
  });
  for (let index = 0; index < 25; index++)
    seed(store, "journal", `j${String(index).padStart(2, "0")}`, {
      at: "2026-01-01",
      type: "application_updated",
      message: "Updated",
      entityId: "application",
    });
}

test("detail reads summarize records, resolve forward and reverse links, and bound raw heavy values", async () => {
  const f = await fixture();
  try {
    seedDetail(f.store);
    const detail = await json<RecordDetail>(
      f,
      "/api/records/application/application",
    );
    assert.equal(detail.row.title, "Engineer");
    assert.ok(
      detail.fields.some(
        (field) => field.label === "Version" && field.value === "3",
      ),
    );
    assert.deepEqual(
      new Set(detail.related.map((link) => link.id)),
      new Set(["opening", "document", "script", "preparation"]),
    );
    assert.equal(detail.activity.length, 20);
    assert.equal(detail.activity[0].id, "j24");
    assert.equal(detail.rawTruncated, true);
    assert.ok(Buffer.byteLength(detail.raw) <= 64 * 1024);
    assert.doesNotThrow(() => JSON.parse(detail.raw));
    assert.ok(!detail.raw.includes("SECRET PDF"));
    const opening = await json<RecordDetail>(f, "/api/records/opening/opening");
    assert.ok(!opening.raw.includes("PRIVATE POSTING"));
    assert.ok(opening.related.some((link) => link.id === "task"));
    const script = await json<RecordDetail>(
      f,
      "/api/records/application_autofill/script",
    );
    assert.ok(!script.raw.includes("SECRET SCRIPT"));
    assert.equal(script.rawTruncated, true);
    const task = await json<RecordDetail>(f, "/api/records/task/task");
    assert.ok(!task.raw.includes("NO TRANSCRIPT"));
  } finally {
    await f.cleanup();
  }
});

function seedActivity(store: Store) {
  seed(store, "cache_opening", "opening", {
    title: "Engineer",
    company: "Acme",
  });
  const records = [
    [
      "one",
      "autofill_fetch",
      "Greenhouse read failed",
      { entityId: "opening" },
    ],
    [
      "two",
      "autofill_fetch",
      "Greenhouse read retrying",
      { applicationId: "opening" },
    ],
    ["three", "validation", "Draft validation failed", { recordId: "opening" }],
    ["four", "application_document_error", "PDF generation failed", {}],
    [
      "five",
      "never_seen_before",
      "Historic entry",
      {
        details: {
          recordId: "opening",
          marker: "needle",
          large: "X".repeat(50_000),
        },
      },
    ],
  ] as const;
  for (const [id, type, message, rest] of records)
    seed(store, "journal", id, { at: "2026-01-01", type, message, ...rest });
}

test("activity classifies outcomes and unknown types, searches, filters entities and bounds details", async () => {
  const f = await fixture();
  try {
    seedActivity(f.store);
    const activity = await json<ActivityPage>(f, "/api/activity");
    assert.equal(activity.total, 5);
    assert.deepEqual(activity.counts.level, { info: 1, warning: 2, error: 2 });
    assert.equal(
      activity.entries.find((entry) => entry.id === "one")?.workflow,
      "Greenhouse autofill",
    );
    assert.equal(
      activity.entries.find((entry) => entry.id === "one")?.entity?.title,
      "Engineer",
    );
    assert.equal(
      activity.entries.find((entry) => entry.id === "five")?.workflow,
      "Activity",
    );
    const big = activity.entries.find((entry) => entry.id === "five");
    assert.equal(big?.detailsTruncated, true);
    assert.ok(Buffer.byteLength(big?.details ?? "") <= 8192);
    assert.doesNotThrow(() => JSON.parse(big?.details ?? "null"));
    const filtered = await json<ActivityPage>(
      f,
      "/api/activity?entity=opening&entity=missing&level=error",
    );
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.counts.level, { info: 1, warning: 2, error: 1 });
    assert.equal(
      (await json<ActivityPage>(f, "/api/activity?q=NEEDLE")).total,
      1,
    );
    assert.equal(
      (await json<ActivityPage>(f, "/api/activity?q=greenhouse%20autofill"))
        .total,
      2,
    );
    const first = await json<ActivityPage>(f, "/api/activity?limit=2");
    const second = await json<ActivityPage>(
      f,
      `/api/activity?limit=2&cursor=${first.nextCursor}`,
    );
    const third = await json<ActivityPage>(
      f,
      `/api/activity?limit=2&cursor=${second.nextCursor}`,
    );
    assert.equal(
      new Set(
        [...first.entries, ...second.entries, ...third.entries].map(
          (entry) => entry.id,
        ),
      ).size,
      5,
    );
    assert.equal(third.nextCursor, undefined);
    assert.equal(
      (await json<ActivityPage>(f, "/api/activity?workflow=Generate%20Docs"))
        .total,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("activity level is a minimum severity while counts remain exact", async () => {
  const f = await fixture();
  try {
    seedActivity(f.store);
    for (const [level, ids] of [
      ["info", ["one", "two", "three", "four", "five"]],
      ["warning", ["one", "two", "three", "four"]],
      ["error", ["one", "four"]],
    ] as const) {
      const page = await json<ActivityPage>(f, `/api/activity?level=${level}`);
      assert.equal(page.total, ids.length);
      assert.deepEqual(
        new Set(page.entries.map((entry) => entry.id)),
        new Set(ids),
      );
      assert.deepEqual(page.counts.level, { info: 1, warning: 2, error: 2 });
    }
    const scoped = await json<ActivityPage>(
      f,
      "/api/activity?level=warning&workflow=Greenhouse%20autofill&entity=opening",
    );
    assert.equal(scoped.total, 2);
    assert.deepEqual(
      new Set(scoped.entries.map((entry) => entry.level)),
      new Set(["warning", "error"]),
    );
    assert.deepEqual(scoped.counts.level, { info: 1, warning: 2, error: 1 });
  } finally {
    await f.cleanup();
  }
});

test("incomplete rescans are warnings from structured summary evidence", async () => {
  const f = await fixture();
  try {
    seed(f.store, "journal", "incomplete", {
      type: "files_reindexed",
      at: "2026-01-01",
      message: "Files rescanned",
      details: { summary: { incomplete: true } },
    });
    seed(f.store, "journal", "complete", {
      type: "files_reindexed",
      at: "2026-01-02",
      message: "Rescan incomplete is old wording",
      details: { summary: { incomplete: false } },
    });
    seed(f.store, "journal", "legacy", {
      type: "files_reindexed",
      at: "2026-01-03",
      message: "Legacy import",
    });
    const page = await json<ActivityPage>(f, "/api/activity?level=warning");
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ["incomplete"],
    );
    assert.equal(page.total, 1);
    assert.deepEqual(page.counts.level, { info: 2, warning: 1, error: 0 });
  } finally {
    await f.cleanup();
  }
});

test("generated documents and their producing tasks link in both directions", async () => {
  const f = await fixture();
  try {
    seed(f.store, "task", "producer", { title: "Tailor resume" });
    seed(f.store, "generated_document", "pdf", {
      name: "resume.pdf",
      generatedBy: "producer",
    });
    const document = await json<RecordDetail>(f, "/api/records/document/pdf");
    const task = await json<RecordDetail>(f, "/api/records/task/producer");
    assert.deepEqual(document.related, [
      { kind: "task", id: "producer", title: "Tailor resume" },
    ]);
    assert.deepEqual(task.related, [
      { kind: "document", id: "pdf", title: "resume.pdf" },
    ]);
    assert.equal(document.relatedTotal, 1);
    assert.equal(task.relatedTotal, 1);
  } finally {
    await f.cleanup();
  }
});

test("related links cap forward and reverse families at 100 while retaining complete totals", async () => {
  const f = await fixture();
  try {
    seed(f.store, "cache_company", "company", { name: "Example" });
    const targets = Array.from({ length: 150 }, (_, index) => {
      const id = `opening-${String(index).padStart(3, "0")}`;
      seed(f.store, "cache_opening", id, {
        title: `Engineer ${index}`,
        company_id: "company",
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      });
      return { id };
    });
    seed(f.store, "opening_validation_run", "validation", {
      targets: [...targets, targets[0], { id: "missing" }],
    });
    const expected = targets
      .slice(50)
      .reverse()
      .map((target) => target.id);
    for (const route of [
      "/api/records/opening_validation_run/validation",
      "/api/records/company/company",
    ]) {
      const detail = await json<RecordDetail>(f, route);
      assert.equal(detail.related.length, 100);
      assert.equal(detail.relatedTotal, 150);
      assert.deepEqual(
        detail.related.map((link) => link.id),
        expected,
      );
    }
    const empty = await json<RecordDetail>(
      f,
      `/api/records/opening/${targets[0].id}`,
    );
    assert.equal(empty.relatedTotal, 2);
  } finally {
    await f.cleanup();
  }
});

test("related links retain older direct references before newer reverse links and deduplicate families", async () => {
  const f = await fixture();
  try {
    seed(f.store, "task", "producer", {
      title: "Tailor resume",
      context: {
        openingId: "direct-opening",
        documentIds: ["doc-000", "producer"],
      },
    });
    seed(f.store, "cache_opening", "direct-opening", {
      title: "Direct role",
      createdAt: "2020-01-01",
    });
    for (let index = 0; index < 120; index++) {
      const id = `doc-${String(index).padStart(3, "0")}`;
      seed(f.store, "generated_document", id, {
        name: `${id}.pdf`,
        generatedBy: "producer",
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      });
    }
    seed(f.store, "cache_document", "doc-010", {
      name: "cached.pdf",
      generatedBy: "producer",
      createdAt: "2026-01-11",
    });
    const detail = await json<RecordDetail>(f, "/api/records/task/producer");
    assert.equal(detail.relatedTotal, 121);
    assert.equal(detail.related.length, 100);
    const reverseIds = Array.from(
      { length: 98 },
      (_, index) => `doc-${String(119 - index).padStart(3, "0")}`,
    );
    assert.deepEqual(
      detail.related.map((link) => link.id),
      ["doc-000", "direct-opening", ...reverseIds],
    );
  } finally {
    await f.cleanup();
  }
});

function seedRuns(store: Store) {
  seed(store, "custom_opening", "opening", {
    title: "Développeur",
    company: "ÉLAN",
    addedAt: "2026-03-01",
  });
  seed(store, "application_autofill", "script", {
    openingId: "opening",
    createdAt: "2026-03-02",
  });
  seed(store, "application_preparation", "preparation", {
    openingId: "opening",
    status: "ready",
    at: "2026-03-03",
  });
  seed(store, "greenhouse_pull_run", "pull", {
    createdAt: "2026-03-04",
    status: "target_reached",
    target: 10,
  });
  for (const [id, state] of [
    ["one", "added"],
    ["two", "added"],
    ["three", "excluded"],
  ])
    seed(store, "greenhouse_pull_candidate", id, { runId: "pull", state });
  seed(store, "opening_validation_run", "validation", {
    startedAt: "2026-03-05",
    status: "completed",
    counts: { open: 3, closed: 2, unknown: 1 },
  });
  seed(store, "career_scan", "scan", {
    startedAt: "2026-03-06",
    mode: "all",
    status: "completed",
    total: 3,
    completed: 3,
    companies: [{ id: "company" }],
  });
  seed(store, "journal", "unicode", {
    at: "2026-03-07",
    type: "company_added",
    message: "ÉLAN imported",
  });
}

test("every workflow kind has descriptive titles, run counts and truthful timestamp labels", async () => {
  const f = await fixture();
  try {
    seedRuns(f.store);
    const page = await json<CatalogPage>(f, "/api/records");
    const byId = new Map(page.rows.map((row) => [row.id, row]));
    assert.equal(byId.get("script")?.title, "ÉLAN · Développeur");
    assert.equal(byId.get("script")?.subtitle, "Created 2026-03-02");
    assert.equal(byId.get("preparation")?.title, "ÉLAN · Développeur");
    assert.equal(byId.get("preparation")?.subtitle, "ready");
    assert.equal(byId.get("pull")?.title, "Greenhouse pull");
    assert.match(
      byId.get("pull")?.subtitle ?? "",
      /2026-03-04.*target_reached.*2\/10 added/,
    );
    assert.match(
      byId.get("validation")?.subtitle ?? "",
      /2026-03-05.*3 open, 2 closed, 1 unknown/,
    );
    assert.equal(byId.get("validation")?.atLabel, "Started");
    assert.match(
      byId.get("scan")?.subtitle ?? "",
      /All monitored companies.*completed/,
    );
    assert.equal((await json<CatalogPage>(f, "/api/records?q=élan")).total, 3);
    assert.equal(
      (await json<ActivityPage>(f, "/api/activity?q=élan")).total,
      1,
    );
    const detail = await json<RecordDetail>(f, "/api/records/career_scan/scan");
    assert.equal(detail.rawTruncated, false);
    assert.equal(JSON.parse(detail.raw).completed, 3);
    assert.ok(
      detail.fields.some((field) => field.label === "Completed companies"),
    );
    const first = await json<CatalogPage>(f, "/api/records?limit=1");
    assert.equal(
      (await f.get(`/api/records?q=other&cursor=${first.nextCursor}`)).status,
      400,
    );
  } finally {
    await f.cleanup();
  }
});
