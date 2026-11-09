import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../server/storage.js";
import { importRepository, parseOpenings } from "../server/importer.js";
import {
  boardEndpoint,
  collectCompany,
  normalizeFeed,
  candidate,
  type CompanyScan,
} from "../server/careers/providers.js";
import {
  reconcileScan,
  selectedPostingEvidence,
  openingsMarkdown,
  validateReconciliation,
} from "../server/careers/reconcile.js";
import { CareersScanManager } from "../server/careers/scans.js";
import {
  publicCareersFetch,
  type CareersFetch,
} from "../server/careers/http.js";
const at = "2026-09-11T12:00:00.000Z";
const companies = [
  {
    id: "example",
    name: "Example",
    fields: {
      "Careers URL": "https://job-boards.greenhouse.io/example",
    },
  },
  {
    id: "other",
    name: "Other",
    fields: {
      "Careers URL": "https://job-boards.greenhouse.io/other",
    },
  },
];
const opening = {
  company_id: "example",
  job_id: "old",
  company: "Example",
  title: "Senior Engineer",
  url: "https://job-boards.greenhouse.io/example/jobs/old",
  location: "US remote",
  compensation: "$150,000–$190,000 base",
  technical_fit: "High",
  remote_fit: "High",
  wlb_outlook: "Unknown",
  status: "NEW",
  why: "Existing editorial fit",
  concerns: "Pager unknown",
  requirements: "React, Node.js",
  wlb_evidence: "Old policy evidence",
  first_seen: "2026-09-05",
  last_confirmed_open: "2026-09-05",
  postingStatus: "confirmed open at last scan",
  deadline: "2026-09-15",
};
function previous() {
  return {
    schema_version: 1,
    last_scan_completed: "2026-09-05T12:00:00Z",
    last_scan_id: "baseline",
    active_company_ids: companies.map((c) => c.id),
    company_results: companies.map((c) => ({
      company_id: c.id,
      company: c.name,
      result: c.id === "example" ? "FAILED" : "SUCCESS",
      sources: [c.fields["Careers URL"]],
      checked_at: "2026-09-05T12:00:00Z",
      notes: "Prior result",
    })),
    current_opening_keys: ["example:old"],
    seen_jobs: {
      "example:old": {
        company_id: "example",
        job_id: "old",
        title: opening.title,
        url: opening.url,
        first_seen: "2026-09-05",
        qualification: "retained",
      },
      "other:history": {
        company_id: "other",
        job_id: "history",
        first_seen: "2026-08-01",
        qualification: "not_retained",
      },
    },
  };
}
const response = (url: string, data: any, status = 200) => ({
  url,
  requestedUrl: url,
  status,
  type: typeof data === "string" ? "text/html" : "application/json",
  text: typeof data === "string" ? data : JSON.stringify(data),
  at,
});
const empty: CareersFetch = async (url) =>
  url.includes("boards-api.greenhouse.io/")
    ? response(url, { jobs: [] })
    : url.endsWith("/old")
      ? response(url, "missing", 404)
      : response(url, "<main>Careers</main>");
function result(): CompanyScan {
  return {
    company_id: "example",
    company: "Example",
    result: "FAILED",
    complete: false,
    inventory_count: null,
    sources: ["https://job-boards.greenhouse.io/example"],
    checked_at: at,
    notes: "Access denied",
    jobs: [],
    direct: { old: { status: "unknown", reason: "HTTP 403", at } },
  };
}

test("provider endpoints come from known public board URL shapes; malformed feeds cannot establish absence", () => {
  assert.equal(boardEndpoint("https://jobs.ashbyhq.com/my-company"), null);
  assert.equal(
    boardEndpoint("https://boards.greenhouse.io/embed/job_board?for=example")
      ?.kind,
    "greenhouse",
  );
  assert.equal(
    boardEndpoint("https://example.wd1.myworkdayjobs.com/en-US/Careers")?.url,
    "https://example.wd1.myworkdayjobs.com/wday/cxs/example/Careers/jobs",
  );
  assert.equal(
    boardEndpoint(
      "https://api.ashbyhq.com.evil.test/posting-api/job-board/example",
    ),
    null,
  );
  assert.throws(
    () =>
      normalizeFeed(
        "greenhouse",
        { jobs: [], meta: { total: 1 } },
        "https://example.com",
        at,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      normalizeFeed("ashby", { error: "denied" }, "https://example.com", at),
    /Unsupported career feed provider/,
  );
});
test("direct 404 during access failure remains unknown; complete empty inventory plus 404 establishes closure", async () => {
  const denied: CareersFetch = async (url) =>
    response(url, "Access denied", url.endsWith("/old") ? 404 : 403);
  const incomplete = await collectCompany(
    companies[0],
    previous().company_results[0],
    [opening],
    denied,
    new AbortController().signal,
  );
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.direct.old.status, "unknown");
  const closed = await collectCompany(
    companies[0],
    previous().company_results[0],
    [opening],
    empty,
    new AbortController().signal,
  );
  assert.equal(closed.complete, true);
  assert.equal(closed.direct.old.status, "closed");
});
test("truncated Workday pages never become complete inventories", async () => {
  const company = {
    ...companies[0],
    fields: {
      ...companies[0].fields,
      "Careers URL": "https://example.wd1.myworkdayjobs.com/Careers",
    },
  };
  const workday: CareersFetch = async (url, body) =>
    response(url, body ? { total: 10, jobPostings: [] } : "careers");
  const w = await collectCompany(
    company,
    null,
    [],
    workday,
    new AbortController().signal,
  );
  assert.equal(w.complete, false);
  assert.match(w.notes, /incomplete/);
});
test("failed scans preserve dates/history and workflow-independent unconfirmed status through Markdown", () => {
  const value = reconcileScan({
    companies,
    previous: previous(),
    openings: [opening],
    results: [result()],
    id: "scan",
    completedAt: at,
    mode: "failed",
  });
  assert.equal(value.openings[0].last_confirmed_open, "2026-09-05");
  assert.equal(value.openings[0].postingStatus, "not confirmed open");
  assert.equal(value.state.seen_jobs["other:history"].first_seen, "2026-08-01");
  assert.equal(value.coverage[1].checked_at, "2026-09-05T12:00:00Z");
  const md = openingsMarkdown(value.openings, at, "research/scans/test");
  assert.doesNotMatch(md, /Overall priority/i);
  const parsed = parseOpenings(md);
  assert.equal(parsed[0].postingStatus, "not confirmed open");
  assert.equal(parsed[0].deadline, "2026-09-15");
  assert.equal(validateReconciliation(value, md, previous()).status, "passed");
});
test("new candidates stay separate from seen history; repeat scans are idempotent and closures are archived", () => {
  const r = result();
  r.result = "SUCCESS";
  r.complete = true;
  r.jobs = [
    {
      id: "new",
      title: "Senior Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/example/jobs/new",
      location: "Remote USA",
      description: "React and Node.js",
      salary: "US band: $160,000–$190,000 base; equity separate.",
      remote: true,
      source: "https://boards-api.greenhouse.io/v1/boards/example/jobs",
      at,
      detailVerified: true,
    },
  ];
  r.direct.old = {
    status: "closed",
    reason: "Complete board and direct 410",
    at,
  };
  const value = reconcileScan({
    companies,
    previous: previous(),
    openings: [opening],
    results: [r],
    id: "scan",
    completedAt: at,
    mode: "all",
  });
  assert.equal(value.openings.length, 1);
  assert.equal(value.openings[0].reviewRequired, true);
  assert.equal(value.openings[0].technical_fit, "Unknown");
  assert.equal(Object.hasOwn(value.openings[0], "priority"), false);
  assert.equal(value.state.archived_openings[0].postingStatus, "closed");
  assert.equal(Object.keys(value.state.seen_jobs).length, 3);
  const again = reconcileScan({
    companies,
    previous: value.state,
    openings: value.openings,
    results: [r],
    id: "next",
    completedAt: at,
    mode: "all",
  });
  assert.equal(again.summary.new, 0);
  assert.equal(again.openings.length, 1);
  assert.equal(Object.keys(again.state.seen_jobs).length, 3);
  assert.equal(again.openings[0].status, "PREVIOUSLY SEEN");
});
test("public careers HTTP blocks local targets and non-search POSTs before making requests", async () => {
  await assert.rejects(
    publicCareersFetch(
      "http://127.0.0.1:4317/api/state",
      new AbortController().signal,
    ),
    /private|Local|public HTTP/,
  );
  await assert.rejects(
    publicCareersFetch(
      "https://example.com/apply",
      new AbortController().signal,
      { offset: 0, limit: 20, searchText: "", appliedFacets: {} },
    ),
    /read-only Workday/,
  );
});
async function fixture(
  fn: (
    store: Store,
    root: string,
    reindex: () => Promise<any>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "careers-manager-"));
  mkdirSync(path.join(root, "company_careers"), { recursive: true });
  writeFileSync(
    path.join(root, "company_careers/companies.md"),
    companies
      .map(
        (c) =>
          `## ${c.name}\n<!-- company_id: ${c.id} -->\n- **Careers URL:** ${c.fields["Careers URL"]}\n`,
      )
      .join("\n"),
  );
  writeFileSync(
    path.join(root, "company_careers/current_openings.md"),
    openingsMarkdown(
      [opening],
      "2026-09-05T12:00:00Z",
      "research/scans/baseline",
    ),
  );
  writeFileSync(
    path.join(root, "company_careers/scan_state.json"),
    JSON.stringify(previous()),
  );
  writeFileSync(
    path.join(root, "company_careers/scan_history.md"),
    "# Career scan history\n\nPrior evidence must remain.\n",
  );
  const store = new Store(root, path.join(root, ".local"));
  const reindex = async () => {
    const r = await importRepository(root);
    store.import(r);
    return r;
  };
  try {
    await reindex();
    await fn(store, root, reindex);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function finished(manager: CareersScanManager) {
  for (let i = 0; i < 200; i++) {
    if (!manager.state().activeId) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Scan did not finish");
}
test("careers state counts monitored companies without building app state", async () =>
  fixture(async (store, _root, _reindex) => {
    store.update("personal", "other", 0, { monitoring: false });
    store.state = () => {
      throw Error("app state should not be built");
    };
    const manager = new CareersScanManager(
      store,
      () => {},
      async () => {},
    );
    assert.equal(manager.state().monitored, 1);
  }));
test("tracked scan publishes validated sources, preserves notes, imports closed history and retries only failed companies", async () =>
  fixture(async (store, root, reindex) => {
    store.update("personal", "example:old", 0, {
      bookmarked: true,
      nextAction: "Preserve my follow-up",
      notes: "Private note",
    });
    const urls: string[] = [];
    const manager = new CareersScanManager(
      store,
      () => {},
      reindex,
      async (u, b) => {
        urls.push(u);
        return empty(u, b);
      },
    );
    try {
      const request = randomUUID(),
        run = manager.start("failed", request);
      assert.equal(manager.start("failed", request).id, run.id);
      assert.throws(
        () => manager.start("all", randomUUID()),
        /already running/,
      );
      await finished(manager);
      const done = store.get("career_scan", run.id)!;
      assert.equal(done.status, "completed", done.error!);
      assert.equal(done.total, 1);
      assert.ok(urls.every((u) => !u.includes("/other")));
      assert.equal(
        store.get("personal", "example:old")!.nextAction,
        "Preserve my follow-up",
      );
      assert.equal(
        store.get("cache_opening", "example:old")!.postingStatus,
        "closed",
      );
      assert.equal(store.get("cache_opening", "example:old")!.retained, false);
      await reindex();
      assert.equal(
        store.get("cache_opening", "example:old")!.postingStatus,
        "closed",
      );
      const state = JSON.parse(
        readFileSync(
          path.join(root, "company_careers/scan_state.json"),
          "utf8",
        ),
      );
      assert.equal(
        state.company_results.find((r: any) => r.company_id === "other")
          .checked_at,
        "2026-09-05T12:00:00Z",
      );
      assert.match(
        readFileSync(
          path.join(root, "company_careers/scan_history.md"),
          "utf8",
        ),
        /Prior evidence must remain/,
      );
      assert.equal(store.personalExport().records.career_scan.length, 1);
    } finally {
      await manager.close();
    }
  }));
test("external source edits during collection block publication without clobbering the edit", async () =>
  fixture(async (store, root, reindex) => {
    const file = path.join(root, "company_careers/current_openings.md");
    let edited = false;
    const manager = new CareersScanManager(
      store,
      () => {},
      reindex,
      async (u, b) => {
        if (!edited) {
          edited = true;
          writeFileSync(
            file,
            readFileSync(file, "utf8") + "\nExternal research note.\n",
          );
        }
        return empty(u, b);
      },
    );
    try {
      const run = manager.start("all", randomUUID());
      await finished(manager);
      assert.equal(store.get("career_scan", run.id)!.status, "failed");
      assert.match(store.get("career_scan", run.id)!.error!, /Source changed/);
      assert.match(readFileSync(file, "utf8"), /External research note/);
      assert.equal(
        JSON.parse(
          readFileSync(
            path.join(root, "company_careers/scan_state.json"),
            "utf8",
          ),
        ).last_scan_id,
        "baseline",
      );
    } finally {
      await manager.close();
    }
  }));

test("candidate screening excludes specialist and foreign-only roles without inventing fit ratings", () => {
  const job: any = {
    title: "Senior Full Stack Engineer",
    location: "Remote USA",
    description: "React, TypeScript and Node.js APIs",
    remote: true,
  };
  assert.equal(candidate(job), true);
  assert.equal(
    candidate({ ...job, title: "Senior Site Reliability Engineer" }),
    false,
  );
  assert.equal(candidate({ ...job, title: "Senior Android Engineer" }), false);
  assert.equal(candidate({ ...job, location: "Sweden | Remote" }), false);
  assert.equal(candidate({ ...job, location: "Portugal" }), false);
});

test("Workday zero total on later pages is metadata omission; complete unique pages are rechecked", async () => {
  const company = {
    ...companies[0],
    fields: {
      ...companies[0].fields,
      "Careers URL": "https://example.wd1.myworkdayjobs.com/Careers",
    },
  };
  const get: CareersFetch = async (url, body) => {
    if (!body) return response(url, "careers");
    const start = body.offset;
    return response(url, {
      total: start === 0 ? 21 : 0,
      jobPostings: Array.from({ length: start === 0 ? 20 : 1 }, (_, i) => ({
        title: "Accountant",
        externalPath: "/job/Remote/Accountant_R" + (start + i),
        bulletFields: ["R" + (start + i)],
        locationsText: "USA",
      })),
    });
  };
  const r = await collectCompany(
    company,
    null,
    [],
    get,
    new AbortController().signal,
  );
  assert.equal(r.complete, true, r.notes);
  assert.equal(r.jobs.length, 21);
});

test("pause/restart/resume keeps finished company checks and resumes only pending work", async () =>
  fixture(async (store, _root, reindex) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let block = true;
    const calls: string[] = [];
    const fetch: CareersFetch = async (u, b) => {
      calls.push(u);
      if (block && u.includes("/other")) await gate;
      return empty(u, b);
    };
    const first = new CareersScanManager(store, () => {}, reindex, fetch);
    const run = first.start("all", randomUUID());
    for (
      let i = 0;
      i < 100 && store.get("career_scan", run.id)!.completed < 1;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.get("career_scan", run.id)!.completed, 1);
    first.pause(run.id);
    release();
    await finished(first);
    await first.close();
    assert.equal(store.get("career_scan", run.id)!.status, "interrupted");
    block = false;
    calls.length = 0;
    const next = new CareersScanManager(store, () => {}, reindex, fetch);
    try {
      next.resume(run.id);
      await finished(next);
      assert.equal(store.get("career_scan", run.id)!.status, "completed");
      assert.ok(calls.length > 0);
      assert.ok(calls.every((u) => u.includes("/other")));
    } finally {
      await next.close();
    }
  }));

test("verification timestamps do not make unchanged roles appear edited since personal review", () => {
  const first = parseOpenings(
    openingsMarkdown(
      [{ ...opening, lastCheckedAt: "2026-09-11T12:00:00Z" }],
      at,
      "scan",
    ),
  )[0];
  const next = parseOpenings(
    openingsMarkdown(
      [
        {
          ...opening,
          lastCheckedAt: "2026-09-12T12:00:00Z",
          last_confirmed_open: "2026-09-12",
          status: "PREVIOUSLY SEEN",
        },
      ],
      at,
      "scan",
    ),
  )[0];
  assert.equal(first.hash, next.hash);
  const changed = parseOpenings(
    openingsMarkdown([{ ...opening, title: "Changed job title" }], at, "scan"),
  )[0];
  assert.notEqual(first.hash, changed.hash);
});

test("missing retained Greenhouse posting is checked through its official detail API before closure", async () => {
  const company = {
    ...companies[0],
    fields: {
      ...companies[0].fields,
      "Careers URL": "https://job-boards.greenhouse.io/example",
    },
  };
  const old = {
    ...opening,
    job_id: "123",
    url: "https://example.com/careers?gh_jid=123",
  };
  const urls: string[] = [];
  const get: CareersFetch = async (u) => {
    urls.push(u);
    if (u.includes("/jobs/123"))
      return response(u, { error: "Not found" }, 404);
    if (u.includes("/jobs?"))
      return response(u, { jobs: [], meta: { total: 0 } });
    return response(u, "<main>Careers page shell</main>");
  };
  const r = await collectCompany(
    company,
    null,
    [old],
    get,
    new AbortController().signal,
  );
  assert.equal(r.direct["123"].status, "closed");
  assert.ok(urls.some((u) => u.includes("/jobs/123")));
  assert.match(r.direct["123"].reason, /posting API/);
});

test("explicit closed banner overrides stale matching JobPosting metadata", async () => {
  const html =
    '<main>This job is no longer available.</main><script type="application/ld+json">' +
    JSON.stringify({
      "@type": "JobPosting",
      title: opening.title,
      description: "React and Node.js",
      identifier: { value: "old" },
      url: opening.url,
    }) +
    "</script>";
  const get: CareersFetch = async (u) =>
    u === opening.url ? response(u, html) : response(u, "Access denied", 403);
  const r = await collectCompany(
    companies[0],
    null,
    [opening],
    get,
    new AbortController().signal,
  );
  assert.equal(r.direct.old.status, "closed");
});

test("partial retries carry full posting evidence with its original date instead of dropping it", () => {
  const old = {
    ...opening,
    description: "Full prior posting evidence",
    descriptionConfirmedAt: "2026-09-05T12:00:00Z",
    descriptionSourcePath: "prior/selected-source-jobs.json",
  };
  const carried = selectedPostingEvidence([opening], [], [old])[0];
  assert.equal(carried.description, old.description);
  assert.equal(carried.confirmed_at, old.descriptionConfirmedAt);
  assert.equal(carried.carried_forward, true);
});

test("careers scans skip dismissed direct checks without losing source history or rediscovering the role", async () =>
  fixture(async (store, root, reindex) => {
    const personal = store.update("personal", "example:old", 0, {
      dismissed: true,
      notes: "Not a fit",
    });
    const urls: string[] = [];
    let listed = false;
    const manager = new CareersScanManager(
      store,
      () => {},
      reindex,
      async (url, body) => {
        urls.push(url);
        if (listed && url.includes("/v1/boards/example/jobs?"))
          return response(url, {
            jobs: [
              {
                id: "old",
                title: opening.title,
                absolute_url: opening.url,
                location: { name: opening.location },
                content: "React and Node.js",
              },
            ],
          });
        return empty(url, body);
      },
    );
    try {
      for (const present of [false, true]) {
        listed = present;
        urls.length = 0;
        const run = manager.start("all", randomUUID());
        await finished(manager);
        assert.equal(store.get("career_scan", run.id)?.status, "completed");
        assert.ok(urls.length > 0, "shared company inventories still run");
        assert.ok(
          !urls.some((url) => url.endsWith("/old")),
          "no individual recheck",
        );
        await reindex();
        const current = parseOpenings(
          readFileSync(
            path.join(root, "company_careers/current_openings.md"),
            "utf8",
          ),
        );
        assert.equal(current.filter((o) => o.id === "example:old").length, 1);
        assert.notEqual(current[0].postingStatus, "closed");
        const state = JSON.parse(
          readFileSync(
            path.join(root, "company_careers/scan_state.json"),
            "utf8",
          ),
        );
        assert.ok(state.current_opening_keys.includes("example:old"));
        assert.equal(state.seen_jobs["example:old"].first_seen, "2026-09-05");
        assert.equal(state.last_scan_summary.new, 0);
        assert.equal(state.last_scan_summary.closed, 0);
        assert.equal(state.archived_openings.length, 0);
        assert.match(
          readFileSync(
            path.join(root, "company_careers/scan_history.md"),
            "utf8",
          ),
          /Prior evidence must remain/,
        );
        assert.deepEqual(store.get("personal", "example:old"), personal);
        assert.ok(store.opening("example:old"));
      }
    } finally {
      await manager.close();
    }
  }));
