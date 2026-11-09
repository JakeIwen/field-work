import {
  at,
  card,
  posting,
  research,
  fixture,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyOpening } from "./fixtures/legacy-records.js";
import {
  stageGreenhouseDecision,
  existingGreenhouseOpening,
  type PullCandidate,
} from "../server/greenhouse-pull.js";
import {
  greenhouseQueries,
  GreenhouseLimit,
  searchUrl,
  parseSearch,
  retryTime,
} from "../server/greenhouse-source.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeFitCriteria } from "../shared/fit-criteria.js";

test("technology-excluded postings are ledgered before research while existing records remain", async () => {
  const f = fixture({
    posting: async (c) => ({
      ...posting(c),
      text: posting(c).text + " Optional C# experience.",
    }),
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      fitCriteria: normalizeFitCriteria({
        technologyExcludeTerms: ["C#", ".NET"],
      }),
    });
    f.store.put("custom_opening", "existing", {
      id: "existing",
      url: card("1").url,
      title: "Saved before exclusion",
    } as Records["custom_opening"]);
    f.manager.start(1, "exclude-test");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    const candidates = f.store.list("greenhouse_pull_candidate");
    assert.equal(candidates.find((c) => c.card.id === "1")?.state, "existing");
    assert.equal(candidates.find((c) => c.card.id === "2")?.state, "excluded");
    assert.match(candidates.find((c) => c.card.id === "2")!.reason!, /C#/);
    assert.equal(f.store.list("task").length, 0);
    assert.equal(
      f.store.get("custom_opening", "existing")?.title,
      "Saved before exclusion",
    );
  } finally {
    await f.close();
  }
});

test("pull target counts only new records, preserves existing metadata, stops at target and backs up the ledger", async () => {
  const f = fixture();
  try {
    f.store.put(
      "custom_opening",
      "old",
      legacyOpening({
        id: "old",
        company_id: "existing-company",
        company: "Existing company",
        url: card("1").url,
        title: "Previously saved",
        postingStatus: "closed",
        createdAt: "2020-01-01",
        dismissed: true,
      }),
    );
    f.store.put(
      "application",
      "sent" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "sent",
        openingId: "old",
        status: "applied",
        submittedAt: "2020-01-02",
      } as Records["application"],
    );
    const r = f.manager.start(1, "click");
    assert.equal(f.manager.start(10, "double-click").id, r.id);
    await f.manager.tick();
    await f.manager.tick(); // page and existing 1
    assert.equal(f.manager.state()!.existing, 1);
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    const reviewed = f.finish();
    await f.manager.tick();
    assert.equal(
      f.manager.state()!.status,
      "finishing",
      f.manager.state()!.error,
    );
    assert.equal(f.manager.state()!.added, 1);
    assert.equal(f.manager.state()!.pending, 1);
    assert.equal(f.manager.state()!.reviewed, 1);
    await f.manager.tick();
    assert.equal(f.calls.filter((c) => c.query).length, 1);
    const added = f.store.get(
      "custom_opening",
      f.manager.state()!.addedOpeningIds[0],
    )!;
    assert.equal(added.technical_fit, "High");
    assert.equal(added.listSummary!.technicalFit, "High");
    assert.equal(added.assessmentSourceHash, added.hash);
    assert.equal(added.listSummarySourceHash, added.hash);
    assert.deepEqual(added.skills, research(reviewed).opening.skills);
    assert.equal(added.skillsSourceHash, added.hash);
    assert.equal(added.first_published, card("2").firstPublished);
    assert.equal(added.greenhouse!.internalJobId, "req-2");
    assert.ok(added.createdAt);
    assert.equal(added.createdAt, added.firstImportedAt);
    assert.equal(f.store.get("custom_opening", "old")!.createdAt, "2020-01-01");
    assert.equal(f.store.get("application", "sent")!.status, "applied");
    assert.equal(
      f.store.list("application").length,
      1,
      "harvest never starts an application",
    );
    assert.equal(
      f.store.personalExport().records.greenhouse_pull_run.length,
      1,
    );
    assert.equal(
      f.store.personalExport().records.greenhouse_pull_candidate.length,
      3,
    );
    assert.equal(
      f.manager.start(1, "click").id,
      r.id,
      "same request remains idempotent after completion",
    );
  } finally {
    await f.close();
  }
});
test("429 cooldown survives pause/restart, respects Retry-After, and retries the exact failed page", async () => {
  let attempt = 0;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      f.calls.push({ query, page });
      if (++attempt === 1)
        throw new GreenhouseLimit(
          "HTTP 429",
          new Date(at + 300000).toISOString(),
        );
      return {
        query,
        page,
        cards: [card("1")],
        more: false,
        employmentTypes,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(at).toISOString(),
        status: 200,
      };
    },
  });
  try {
    const r = f.manager.start();
    await f.manager.tick();
    assert.equal(f.manager.state()!.status, "cooldown");
    assert.equal(f.manager.state()!.page, 1);
    await f.manager.tick();
    assert.equal(attempt, 1);
    await f.restart();
    assert.equal(f.manager.state()!.status, "paused");
    f.manager.action(r.id, "resume");
    assert.equal(f.manager.state()!.status, "cooldown");
    f.setTime(at + 300001);
    await f.manager.tick();
    assert.deepEqual(f.calls, [
      { query: greenhouseQueries[0], page: 1 },
      { query: greenhouseQueries[0], page: 1 },
    ]);
    assert.equal(f.manager.ledger(r.id).run.failures.length, 1);
    assert.equal(f.manager.ledger(r.id).run.pages.length, 1);
  } finally {
    await f.close();
  }
});
test("paused completed review does not publish until resumed; later freshness is rechecked", async () => {
  const f = fixture();
  try {
    const r = f.manager.start(1);
    await f.manager.tick();
    await f.manager.tick();
    await f.manager.tick();
    f.manager.action(r.id, "pause");
    f.finish();
    await f.manager.tick();
    assert.equal(f.store.openings().length, 0);
    f.manager.action(r.id, "resume");
    await f.manager.tick();
    assert.equal(f.manager.state()!.added, 1);
  } finally {
    await f.close();
  }
  const expired = fixture();
  try {
    const r = expired.manager.start(1);
    await expired.manager.tick();
    await expired.manager.tick();
    await expired.manager.tick();
    expired.manager.action(r.id, "pause");
    expired.finish();
    expired.setTime(at + 7 * 86400000);
    expired.manager.action(r.id, "resume");
    await expired.manager.tick();
    assert.equal(expired.manager.state()!.added, 0);
    assert.equal(expired.manager.state()!.excluded, 1);
  } finally {
    await expired.close();
  }
});
test("deduplicates public IDs across hosts and current internal requisition aliases, even when dismissed", async () => {
  const f = fixture();
  try {
    f.store.put(
      "cache_opening",
      "legacy",
      legacyOpening({
        id: "legacy",
        url: "https://company.example/careers?gh_jid=90",
        dismissed: true,
      }),
    );
    assert.equal(existingGreenhouseOpening(f.store, card("90"))!.id, "legacy");
    assert.equal(
      existingGreenhouseOpening(f.store, card("1"), {
        ...posting(card("1")),
        aliases: ["1", "90"],
      })!.id,
      "legacy",
    );
    assert.equal(existingGreenhouseOpening(f.store, card("2")), undefined);
    f.store.put(
      "custom_opening",
      "old-alias",
      legacyOpening({
        id: "old-alias",
        url: card("50").url,
        company: "Example",
        internalJobId: "req-2",
        greenhouseAliases: [
          {
            publicJobId: "99",
            urls: ["https://job-boards.greenhouse.io/example/jobs/99"],
          },
        ],
      }),
    );
    assert.equal(
      existingGreenhouseOpening(f.store, card("99"))!.id,
      "old-alias",
    );
    assert.equal(
      existingGreenhouseOpening(f.store, card("2"), posting(card("2")))!.id,
      "old-alias",
      "legacy internal IDs survive removal of the older public advertisement",
    );
  } finally {
    await f.close();
  }
});
test("date checks use official original publication; unknown dates defer and recent updates do not count", async () => {
  const f = fixture({
    posting: async (c) => ({
      ...posting(c),
      raw: {
        ...posting(c).raw,
        first_published: c.id === "1" ? "2020-01-01" : null,
        updated_at: new Date(at).toISOString(),
      },
    }),
  });
  try {
    f.manager.start();
    await f.manager.tick();
    await f.manager.tick();
    await f.manager.tick();
    await advanceUntil(
      f,
      () =>
        f.manager.state()!.excluded === 1 && f.manager.state()!.deferred === 1,
    );
    assert.equal(f.manager.state()!.excluded, 1);
    assert.equal(f.manager.state()!.deferred, 1);
    assert.equal(f.store.list("task").length, 0);
  } finally {
    await f.close();
  }
});
test("repeated pages stop whole-search collection without proving exhaustion or starting reviews", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      cards: [card("1")],
      more: true,
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
  try {
    f.manager.start();
    await f.manager.tick();
    assert.equal(f.manager.state()!.excluded, 0);
    assert.equal(f.manager.state()!.reviewed, 0);
    assert.equal(f.store.list("task").length, 0);
    await advanceUntil(f, () => f.manager.state()!.status === "failed");
    assert.equal(f.manager.state()!.status, "failed");
    assert.equal(f.manager.state()!.page, 2);
    assert.match(f.manager.state()!.error!, /repeated/);
    assert.equal(f.manager.state()!.added, 0);
  } finally {
    await f.close();
  }
});
test("all queries need explicit terminal pages before exhaustion; network errors retain the page", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      cards: [],
      more: false,
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
  try {
    f.manager.start();
    for (let i = 0; i <= greenhouseQueries.length; i++) await f.manager.tick();
    assert.equal(f.manager.state()!.status, "exhausted");
    assert.equal(
      f.manager.ledger(f.manager.state()!.id).run.pages.length,
      greenhouseQueries.length,
    );
  } finally {
    await f.close();
  }
  const bad = fixture({
    page: async () => {
      throw Error("HTTP 503");
    },
  });
  try {
    bad.manager.start();
    await bad.manager.tick();
    assert.equal(bad.manager.state()!.status, "failed");
    assert.equal(bad.manager.state()!.page, 1);
  } finally {
    await bad.close();
  }
});
test("saved decisions require current task identity, canonical research and captured dates", async () => {
  const f = fixture();
  try {
    const r = f.manager.start();
    await f.manager.tick();
    await f.manager.tick();
    await f.manager.tick();
    const c = f.store.list("greenhouse_pull_candidate")[0] as PullCandidate,
      task = f.store.get("task", c.taskId!);
    assert.throws(
      () =>
        stageGreenhouseDecision(f.store, task, {
          ...research(c),
          opening: { ...research(c).opening, firstPublishedAt: "2026-09-28" },
        }),
      /original first_published/,
    );
    assert.throws(
      () =>
        stageGreenhouseDecision(f.store, task, {
          ...research(c),
          opening: {
            ...research(c).opening,
            technicalFit: "High; lots of JavaScript",
          },
        }),
      /High, Medium/,
    );
    f.manager.action(r.id, "stop", true);
    assert.throws(
      () => stageGreenhouseDecision(f.store, task, research(c)),
      /no longer current/,
    );
    await f.manager.tick();
    assert.equal(f.store.openings().length, 0);
  } finally {
    await f.close();
  }
});
test("search schema rejects wrong filters/pages/missing terminal evidence and strips account data", () => {
  const data = {
    component: "jobs",
    url: searchUrl("software", 2),
    props: {
      page: 2,
      moreResultsAvailable: false,
      jobPosts: [
        {
          id: 1,
          title: "Software Engineer",
          companyName: "Example",
          urlToken: "example",
          publicUrl: card("1").url,
        },
      ],
      trackingData: { user_id: "private" },
    },
  };
  const parsed = parseSearch(JSON.stringify(data), "software", 2);
  assert.equal(parsed.cards[0].id, "1");
  assert.ok(!JSON.stringify(parsed).includes("private"));
  assert.throws(
    () => parseSearch(JSON.stringify(data), "software", 1),
    /requested results/,
  );
  assert.throws(
    () =>
      parseSearch(
        JSON.stringify({ ...data, url: data.url.replace("remote", "hybrid") }),
        "software",
        2,
      ),
    /filters changed/,
  );
  assert.throws(
    () =>
      parseSearch(
        JSON.stringify({
          ...data,
          props: { ...data.props, moreResultsAvailable: undefined },
        }),
        "software",
        2,
      ),
    /requested results/,
  );
  assert.equal(Date.parse(retryTime("300", at)), at + 300000);
  assert.equal(Date.parse(retryTime("1", at)), at + 120000);
});
test("Stop interrupts only its own review and late failures cannot corrupt a subsequent run", async () => {
  const f = fixture();
  try {
    const r = f.manager.start();
    await f.manager.tick();
    await f.manager.tick();
    await f.manager.tick();
    const taskId = f.manager.state()!.taskId!;
    f.manager.action(r.id, "stop", true);
    assert.deepEqual(
      f.calls.filter((c) => c.interrupt),
      [{ interrupt: taskId }],
    );
    assert.equal(f.store.get("task", taskId)!.status, "interrupted");
  } finally {
    await f.close();
  }
  let fail!: (error: Error) => void;
  const delayed = fixture({
    page: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  });
  try {
    const first = delayed.manager.start();
    const tick = delayed.manager.tick();
    delayed.manager.action(first.id, "stop");
    const next = delayed.manager.start();
    fail(Error("Old request failed"));
    await tick;
    assert.equal(delayed.manager.state()!.id, next.id);
    assert.equal(delayed.manager.state()!.status, "running");
    assert.equal(delayed.manager.state()!.error, undefined);
  } finally {
    await delayed.close();
  }
});
test("stop API defaults to finishing reviews and validates the explicit interrupt option", async () => {
  const f = fixture();
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-stop-api-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    const run = f.manager.start();
    for (const interruptReviews of [undefined, true]) {
      workspace.store.put("greenhouse_pull_run", run.id, {
        ...run,
        status: "paused",
      });
      const endpoint = `/api/greenhouse/pulls/${run.id}/action`;
      const invalid = await workspace.post(endpoint, {
        action: "stop",
        interruptReviews: "true",
      });
      assert.equal(invalid.status, 400);
      assert.equal(
        workspace.store.get("greenhouse_pull_run", run.id)?.status,
        "paused",
      );
      const response = await workspace.post(endpoint, {
        action: "stop",
        ...(interruptReviews === undefined ? {} : { interruptReviews }),
      });
      assert.equal(response.status, 200);
      const stopped = await response.json();
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.finishReviews, false);
    }
    workspace.store.put("greenhouse_pull_run", run.id, {
      ...run,
      status: "paused",
    });
    const response = await workspace.post(
      `/api/greenhouse/pulls/${run.id}/action`,
      { action: "stop_reviews" },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).finishReviews, false);
  } finally {
    await workspace.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt failure rolls back the opening/company publication, and retry creates exactly one opening", async () => {
  const f = fixture();
  try {
    const r = f.manager.start(1);
    await f.manager.tick();
    await f.manager.tick();
    await f.manager.tick();
    f.finish();
    const put = f.store.put.bind(f.store);
    f.store.put = (kind, id, value) => {
      // The checked registry key fixes the payload shape; a generic key cannot narrow its value.
      if (
        kind === "greenhouse_pull_candidate" &&
        (value as Records["greenhouse_pull_candidate"]).state === "added"
      )
        throw Error("Receipt fixture failure");
      return put(kind, id, value);
    };
    await f.manager.tick();
    f.store.put = put;
    assert.equal(f.manager.state()!.status, "failed");
    assert.equal(f.store.list("custom_opening").length, 0);
    assert.equal(f.store.list("custom_company").length, 0);
    f.manager.action(r.id, "resume");
    await f.manager.tick();
    assert.equal(f.manager.state()!.status, "finishing");
    assert.equal(f.store.list("custom_opening").length, 1);
  } finally {
    await f.close();
  }
});
