import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyOpening,
  legacyValidationRun,
} from "./fixtures/legacy-records.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync, strFromU8 } from "fflate";
import { Store } from "../server/storage.js";
import {
  inspectPosting,
  validateOpening,
  OpeningValidationManager,
} from "../server/opening-validation.js";
import {
  isActiveOpening,
  isClosedOpening,
  openingVisibleInList,
} from "../shared/opening-availability.js";
import type { CareersResponse } from "../server/careers/http.js";

const role = {
  id: "example:123",
  company_id: "example",
  company: "Example",
  job_id: "123",
  title: "Senior Engineer",
  url: "https://job-boards.greenhouse.io/example/jobs/123",
  postingStatus: "open",
};
const gh = {
  id: 123,
  title: role.title,
  absolute_url: role.url,
  content: "<p>Build and maintain software systems.</p>",
  location: { name: "Remote" },
};
const page = (
  url: string,
  status: number,
  body: unknown,
  finalUrl = url,
): CareersResponse => ({
  requestedUrl: url,
  url: finalUrl,
  status,
  type: typeof body === "string" ? "text/html" : "application/json",
  text: typeof body === "string" ? body : JSON.stringify(body),
  at: new Date().toISOString(),
});
const signal = () => new AbortController().signal;

test("Greenhouse: matching official detail opens; missing detail needs a working, consistent board", async () => {
  let r = await validateOpening(
    role,
    async (url) => page(url, 200, gh),
    signal(),
  );
  assert.equal(r.status, "open");
  for (const [boardStatus, data, expected] of [
    [200, { jobs: [], meta: { total: 0 } }, "closed"],
    [200, { jobs: [gh], meta: { total: 1 } }, "unknown"],
    [403, {}, "unknown"],
    [404, {}, "unknown"],
  ] as const) {
    r = await validateOpening(
      role,
      async (url) =>
        url.includes("/jobs/123")
          ? page(url, 404, {})
          : page(url, boardStatus, data),
      signal(),
    );
    assert.equal(r.status, expected);
  }
  await assert.rejects(
    validateOpening(
      role,
      async (url) => page(url, 200, "<html>Challenge</html>"),
      signal(),
    ),
  );
  r = await validateOpening(
    role,
    async (url) => page(url, 200, { ...gh, id: 456 }),
    signal(),
  );
  assert.equal(r.status, "unknown");
  r = await validateOpening(
    role,
    async (url) => page(url, 404, {}, "https://example.com/not-found"),
    signal(),
  );
  assert.equal(
    r.status,
    "unknown",
    "API redirect must not be treated as removal",
  );
  r = await validateOpening(
    role,
    async (url) => page(url, 404, "Access denied"),
    signal(),
  );
  assert.equal(
    r.status,
    "unknown",
    "a block disguised as 404 must not be treated as removal",
  );
});

test("Generic checks do not equate blocked pages, redirects, expired dates or shells with closure", () => {
  const url = "https://example.com/jobs/123";
  const o = { ...role, url };
  const check = (
    status: number,
    body: string,
    finalUrl = url,
    absent = false,
  ) => inspectPosting(page(url, status, body, finalUrl), o, absent).status;
  assert.equal(check(404, "Not found"), "unknown");
  assert.equal(check(404, "Not found", url, true), "closed");
  assert.equal(
    check(404, "Not found", "https://example.com/careers", true),
    "unknown",
  );
  assert.equal(
    check(200, "<main>This job is no longer available.</main>"),
    "closed",
  );
  assert.equal(
    check(200, "<h1>This job is closed</h1><p>Verify you are human</p>"),
    "unknown",
  );
  assert.equal(
    check(200, "<h1>This job is closed</h1>", "https://example.com/careers"),
    "unknown",
  );
  assert.equal(check(200, "<div id='root'></div>"), "unknown");
  const schema = (job: any) =>
    `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: o.title, description: "Engineering duties", ...job })}</script>`;
  assert.equal(check(200, schema({ url })), "open");
  assert.equal(
    check(200, schema({ url, validThrough: "2001-01-01" })),
    "unknown",
  );
  assert.equal(
    check(
      200,
      schema({ title: "Different role", identifier: { value: "456" } }),
    ),
    "unknown",
  );
});

test("Workday detail must match the stored requisition", async () => {
  const o = {
    ...role,
    url: "https://example.wd1.myworkdayjobs.com/en-US/External/job/Remote/Engineer_123",
  };
  for (const [jobReqId, expected] of [
    ["123", "open"],
    ["456", "unknown"],
  ]) {
    const r = await validateOpening(
      o,
      async (url) =>
        page(url, 200, {
          jobPostingInfo: { jobReqId, jobDescription: "Build things" },
        }),
      signal(),
    );
    assert.equal(r.status, expected);
  }
});

async function fixture(fn: (store: Store) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opening-validation-"));
  const store = new Store(root, path.join(root, "data"));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function finished(manager: OpeningValidationManager) {
  for (let i = 0; i < 500 && manager.state()?.status === "running"; i++)
    await delay(5);
  assert.equal(manager.state()?.status, "completed", manager.state()?.error);
  // Allow the runner's finalizer to settle before another start.
  await delay(0);
}

test("deleting a validation run during a fetch skips late results and completion", async (t) =>
  fixture(async (store) => {
    store.put("cache_opening", role.id, legacyOpening(role));
    const warnings = t.mock.method(console, "warn", () => {});
    let entered = () => {};
    let release = () => {};
    const fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new OpeningValidationManager(
      store,
      () => {},
      async (url) => {
        entered();
        await gate;
        return page(url, 200, gh);
      },
      0,
    );
    try {
      const run = manager.start(role.id);
      assert.ok(run);
      await fetching;
      store.remove("opening_validation_run", run.id);
      release();
      for (let i = 0; i < 500 && manager.active; i++) await delay(1);
      assert.equal(manager.active, false);
      assert.equal(store.get("opening_validation_run", run.id), undefined);
      assert.equal(store.get("opening_validation", role.id), undefined);
      assert.equal(
        store
          .list("journal")
          .some((entry) => entry.type === "openings_validated"),
        false,
      );
      assert.match(
        String(warnings.mock.calls[0]?.arguments[0]),
        /missing opening validation run/,
      );
    } finally {
      release();
      await manager.close();
    }
  }));

test("cancelling validation during pacing interrupts without recording a result", () =>
  fixture(async (store) => {
    store.put("cache_opening", role.id, legacyOpening(role));
    let requests = 0;
    const manager = new OpeningValidationManager(
      store,
      () => {},
      async (url) => {
        requests++;
        return page(url, 200, gh);
      },
      60_000,
    );
    const run = manager.start(role.id);
    assert.ok(run);
    await manager.close();
    assert.equal(manager.state()?.status, "interrupted");
    assert.equal(manager.state()?.completed, 0);
    assert.equal(manager.state()?.results.length, 0);
    assert.equal(requests, 0);
    assert.equal(store.get("opening_validation", role.id), undefined);
    assert.equal(
      store
        .list("journal")
        .some((entry) => entry.type === "openings_validated"),
      false,
    );
  }));

test("Bulk progress, idempotent start, reindex persistence, URL binding, rechecks and backup evidence", async () =>
  fixture(async (store) => {
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      role as Records["cache_opening"],
    );
    store.put(
      "cache_opening",
      "closed" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...role,
        id: "closed",
        postingStatus: "closed",
      } as Records["cache_opening"],
    );
    store.put(
      "cache_opening",
      "history" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...role,
        id: "history",
        retained: false,
      } as Records["cache_opening"],
    );
    store.put("cache_opening", "not-interested", {
      ...role,
      id: "not-interested",
      url: "https://job-boards.greenhouse.io/acme/jobs/456",
    } as Records["cache_opening"]);
    store.put("personal", "not-interested", { version: 1, dismissed: true });
    let mode = "closed";
    const manager = new OpeningValidationManager(
      store,
      () => {},
      async (url) => {
        if (mode === "unknown") return page(url, 403, "Forbidden");
        if (mode === "open") return page(url, 200, gh);
        return url.includes("/jobs/123")
          ? page(url, 404, {})
          : page(url, 200, { jobs: [] });
      },
      0,
    );
    const run = manager.start();
    assert.equal(manager.start()!.id, run!.id);
    assert.equal(
      run!.total,
      1,
      "closed, historical and Not interested postings are skipped",
    );
    await finished(manager);
    assert.equal(manager.state()!.completed, 1);
    assert.equal(manager.state()!.counts.closed, 1);
    assert.deepEqual(manager.state()!.visibilityChanges, {
      hidden: 1,
      restored: 0,
    });
    assert.equal(isActiveOpening(store.opening(role.id)!), false);
    // The next source import can replace the cache without overwriting the validation.
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { ...role, hash: "new-research" } as Records["cache_opening"],
    );
    assert.equal(isClosedOpening(store.opening(role.id)!), true);
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...role,
        url: role.url + "?utm_campaign=tracking-only",
      } as Records["cache_opening"],
    );
    mode = "unknown";
    manager.start(role.id);
    await finished(manager);
    assert.equal(store.opening(role.id)!.validation!.status, "unknown");
    assert.deepEqual(manager.state()!.visibilityChanges, {
      hidden: 0,
      restored: 0,
    });
    assert.equal(
      isClosedOpening(store.opening(role.id)!),
      true,
      "failed recheck must preserve last confirmed closure",
    );
    mode = "open";
    manager.start(role.id);
    await finished(manager);
    assert.equal(isActiveOpening(store.opening(role.id)!), true);
    assert.deepEqual(manager.state()!.visibilityChanges, {
      hidden: 0,
      restored: 1,
    });
    const backup = unzipSync(store.backup());
    const exported = JSON.parse(strFromU8(backup["personal-export.json"]));
    assert.equal(exported.records.opening_validation_run.length, 3);
    for (const r of exported.records.opening_validation_run)
      for (const result of r.results)
        for (const hash of result.evidenceHashes)
          assert.ok(backup[`objects/${hash}`]);
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...role,
        url: "https://example.com/new",
      } as Records["cache_opening"],
    );
    assert.equal(store.opening(role.id)!.validation, undefined);
    await manager.close();
  }));

test("Rate limiting is unknown, makes progress, and prevents further requests to that host", async () =>
  fixture(async (store) => {
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      role as Records["cache_opening"],
    );
    store.put(
      "cache_opening",
      "second" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...role,
        id: "second",
        url: role.url.replace("123", "456"),
      } as Records["cache_opening"],
    );
    let requests = 0;
    const manager = new OpeningValidationManager(
      store,
      () => {},
      async (url) => {
        requests++;
        return page(url, 429, "Rate limited");
      },
      0,
    );
    manager.start();
    await finished(manager);
    assert.equal(requests, 1);
    assert.equal(manager.state()!.completed, 2);
    assert.equal(manager.state()!.counts.unknown, 2);
    assert.equal(store.openings().filter(isActiveOpening).length, 2);
    await manager.close();
  }));

test("Restart resumes remaining targets, while a changed URL cannot inherit a check in flight", async () =>
  fixture(async (store) => {
    store.put(
      "cache_opening",
      role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      role as Records["cache_opening"],
    );
    store.put(
      "opening_validation_run",
      "restart",
      legacyValidationRun({
        id: "restart",
        status: "running",
        targets: [{ id: role.id, url: role.url }],
        total: 1,
        completed: 0,
        counts: { open: 0, closed: 0, unknown: 0 },
        results: [],
      }),
    );
    const manager = new OpeningValidationManager(
      store,
      () => {},
      async (url) => {
        store.put(
          "cache_opening",
          role.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
          {
            ...role,
            url: "https://example.com/new",
          } as Records["cache_opening"],
        );
        return page(url, 200, gh);
      },
      0,
    );
    assert.equal(manager.state()!.status, "interrupted");
    manager.resume();
    await finished(manager);
    assert.equal(manager.state()!.counts.unknown, 1);
    assert.equal(store.get("opening_validation", role.id), undefined);
    await manager.close();
  }));

test("New source confirmation can supersede older validation, but research edits cannot", () => {
  const validation: any = {
    status: "closed",
    confirmedStatus: "closed",
    confirmedAt: "2026-09-20T12:00:00Z",
  };
  assert.equal(
    isClosedOpening({
      postingStatus: "open",
      validation,
      lastCheckedAt: "2026-09-19T12:00:00Z",
    }),
    true,
  );
  assert.equal(
    isClosedOpening({
      postingStatus: "open",
      validation,
      lastCheckedAt: "2026-09-21T12:00:00Z",
    }),
    false,
  );
});

test("Closed filter reveals archived closed postings without requiring the unrelated history filter", () => {
  const closed = { postingStatus: "closed", retained: false };
  assert.equal(
    openingVisibleInList(closed, { closed: false, history: true }),
    false,
  );
  assert.equal(
    openingVisibleInList(closed, { closed: true, history: false }),
    true,
  );
  assert.equal(
    openingVisibleInList(
      { postingStatus: "not confirmed open", retained: false },
      { closed: true, history: false },
    ),
    false,
  );
  const reopened = {
    ...closed,
    closedAt: "2026-09-19T12:00:00Z",
    validation: {
      confirmedStatus: "open",
      confirmedAt: "2026-09-20T12:00:00Z",
    } as any,
  };
  assert.equal(isActiveOpening(reopened), true);
  assert.equal(
    openingVisibleInList(reopened, { closed: false, history: false }),
    true,
  );
  assert.equal(
    isActiveOpening({ ...reopened, closedAt: "2026-09-21T12:00:00Z" }),
    false,
  );
});
