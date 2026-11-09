import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreenhousePullPolicy } from "../shared/greenhouse-policy.js";
import { newGreenhouseQueryPlan } from "../server/greenhouse-query-plan.js";
import {
  captureGreenhousePolicy,
  runGreenhousePolicy,
} from "../server/opening-pull/policy.js";
import {
  greenhouseCardDisposition,
  greenhouseCompanyDisposition,
} from "../server/opening-pull/card-triage.js";
import { pullDateDisposition } from "../server/opening-pull/dates.js";
import { pullPostingExclusion } from "../server/opening-pull/screen.js";
import { classifyPullScreen } from "../server/opening-pull/metric-classifiers.js";
import type { PullCandidate } from "../server/greenhouse-pull-records.js";
import {
  fixture,
  card,
  posting,
  at,
} from "./fixtures/greenhouse-pull-fixture.js";

const day = 86400000;

test("start captures policy and lists; restart, resume and finishing retain them", async () => {
  const f = fixture();
  try {
    const old = f.store.settings();
    const saved = {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        freshnessDays: 3,
        regularSearchTerms: ["backend", "web"],
      },
      fitCriteria: {
        ...old.fitCriteria,
        titleExcludeTerms: ["mobile"],
        technologyExcludeTerms: ["Java"],
      },
      greenhouseExcludedCompanies: ["Other"],
    };
    f.store.put("settings", "main", saved);
    const run = f.manager.start(1, "captured");
    assert.deepEqual(
      run.policy,
      captureGreenhousePolicy(saved, new Date(at).toISOString()),
    );
    assert.equal(run.cutoff, new Date(at - 3 * day).toISOString());
    assert.deepEqual(
      run.queryPlan?.map((query) => query.query),
      ["backend", "web"],
    );
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: { ...defaultGreenhousePullPolicy, freshnessDays: 10 },
    });
    assert.deepEqual(f.manager.state()?.policy, run.policy);
    f.manager.action(run.id, "pause");
    await f.restart();
    assert.deepEqual(f.manager.action(run.id, "resume").policy, run.policy);
    assert.deepEqual(f.manager.action(run.id, "stop").policy, run.policy);
  } finally {
    await f.close();
  }
});

test("freshness screens and reasons use captured days, card margin and moving window", async () => {
  const f = fixture();
  try {
    const settings = f.store.settings();
    f.store.put("settings", "main", {
      ...settings,
      greenhousePolicy: { ...defaultGreenhousePullPolicy, freshnessDays: 2 },
    });
    const run = f.manager.start();
    const candidate: PullCandidate = {
      id: "candidate",
      runId: run.id,
      state: "discovered",
      card: {
        ...card("1"),
        firstPublished: new Date(at - 3 * day - 1).toISOString(),
      },
    };
    const reason = greenhouseCardDisposition(
      f.store,
      candidate,
      [],
      at,
    )?.reason;
    assert.equal(reason, "Older than 3 days by search date");
    assert.deepEqual(classifyPullScreen(reason ?? ""), [
      { metric: "searchDate" },
    ]);
    candidate.card.firstPublished = new Date(at - 3 * day).toISOString();
    assert.equal(
      greenhouseCardDisposition(f.store, candidate, [], at),
      undefined,
    );
    const oldPosting = pullDateDisposition(run, posting(candidate.card), at);
    assert.match(oldPosting?.reason ?? "", /2-day window/);
    assert.deepEqual(classifyPullScreen(oldPosting?.reason ?? ""), [
      { metric: "publicationDate" },
    ]);
    candidate.card.firstPublished = new Date(at - day).toISOString();
    assert.equal(
      pullDateDisposition(run, posting(candidate.card), at),
      undefined,
    );
    assert.equal(
      pullDateDisposition(run, posting(candidate.card), at + 2 * day)?.state,
      "excluded",
    );
  } finally {
    await f.close();
  }
});

test("disabled title recognition still applies frozen title terms; technologies and travel use captured values", async () => {
  const f = fixture();
  try {
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        titleTriage: false,
        travelCapPercent: 20,
      },
      fitCriteria: {
        ...old.fitCriteria,
        titleExcludeTerms: ["manager"],
        technologyExcludeTerms: ["Java"],
      },
    });
    const run = f.manager.start();
    f.store.put("settings", "main", {
      ...old,
      fitCriteria: {
        ...old.fitCriteria,
        titleExcludeTerms: ["accountant"],
        technologyExcludeTerms: ["React"],
      },
    });
    const candidate: PullCandidate = {
      id: "candidate",
      runId: run.id,
      state: "discovered",
      card: { ...card("1"), title: "Accountant" },
    };
    assert.equal(
      greenhouseCardDisposition(f.store, candidate, [], at),
      undefined,
    );
    assert.match(
      greenhouseCardDisposition(
        f.store,
        { ...candidate, card: { ...candidate.card, title: "Sales Manager" } },
        [],
        at,
      )?.reason ?? "",
      /excluded title term “manager”/,
    );
    const job = posting(candidate.card);
    assert.equal(pullPostingExclusion(f.store, candidate, job), undefined);
    assert.match(
      pullPostingExclusion(f.store, candidate, {
        ...job,
        text: "Java preferred.",
      }) ?? "",
      /Posting mentions Java/,
    );
    assert.equal(
      pullPostingExclusion(f.store, candidate, {
        ...job,
        text: "Travel up to 20%.",
      }),
      undefined,
    );
    assert.match(
      pullPostingExclusion(f.store, candidate, {
        ...job,
        text: "Travel up to 25%.",
      }) ?? "",
      /20% pull limit/,
    );
    assert.ok(run.policy);
    const travel = { ...job, text: "Travel 100%." };
    assert.equal(
      pullPostingExclusion(f.store, candidate, travel, {
        ...run.policy,
        travelCapPercent: null,
      }),
      undefined,
    );
    assert.match(
      pullPostingExclusion(
        f.store,
        candidate,
        { ...job, text: "Travel 1%." },
        { ...run.policy, travelCapPercent: 0 },
      ) ?? "",
      /0% pull limit/,
    );
  } finally {
    await f.close();
  }
});

test("captured companies cannot be removed mid-run while live additions still stop queued candidates", async () => {
  const f = fixture();
  try {
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhouseExcludedCompanies: ["Example"],
    });
    const run = f.manager.start();
    f.store.put("settings", "main", {
      ...old,
      greenhouseExcludedCompanies: ["New company"],
    });
    const candidate: PullCandidate = {
      id: "candidate",
      runId: run.id,
      state: "discovered",
      card: card("1"),
    };
    assert.equal(
      greenhouseCompanyDisposition(f.store, candidate)?.state,
      "excluded",
    );
    assert.equal(
      greenhouseCompanyDisposition(f.store, {
        ...candidate,
        card: { ...candidate.card, company: "New company", board: "new" },
      })?.state,
      "excluded",
    );
    assert.equal(
      greenhouseCompanyDisposition(f.store, {
        ...candidate,
        state: "reviewing",
      }),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("legacy runs ignore saved policy but retain the original fixed rules and live lists", async () => {
  const f = fixture();
  try {
    const run = f.manager.start();
    const { policy: _policy, ...legacy } = run;
    f.store.put("greenhouse_pull_run", run.id, legacy);
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        freshnessDays: 1,
        titleTriage: false,
        travelCapPercent: null,
      },
      fitCriteria: {
        ...old.fitCriteria,
        technologyExcludeTerms: ["Java"],
        titleExcludeTerms: ["mobile"],
      },
    });
    const derived = runGreenhousePolicy(legacy, f.store.settings());
    assert.equal(derived.legacy, true);
    assert.equal(derived.capturedAt, "");
    assert.equal(derived.freshnessDays, 7);
    assert.equal(derived.travelCapPercent, 5);
    assert.deepEqual(derived.technologyExcludeTerms, ["Java"]);
    assert.deepEqual(f.manager.state()?.policy, derived);
    const candidate: PullCandidate = {
      id: "candidate",
      runId: run.id,
      state: "discovered",
      card: { ...card("1"), title: "Accountant" },
    };
    assert.match(
      greenhouseCardDisposition(f.store, candidate, [], at)?.reason ?? "",
      /not a software/,
    );
    assert.match(
      pullPostingExclusion(f.store, candidate, {
        ...posting(candidate.card),
        text: "Travel 6%.",
      }) ?? "",
      /5% pull limit/,
    );
    assert.equal(
      pullDateDisposition(legacy, posting(candidate.card), at),
      undefined,
    );
    assert.equal(f.store.get("greenhouse_pull_run", run.id)?.policy, undefined);
  } finally {
    await f.close();
  }
});

test("rotation follows the previous first regular term by text across changed lists", async () => {
  const f = fixture();
  try {
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        regularSearchTerms: ["custom", "backend", "web"],
      },
    });
    const previous = f.manager.start();
    assert.equal(
      newGreenhouseQueryPlan(previous, [], undefined, [
        "web",
        "custom",
        "backend",
      ])[0].query,
      "backend",
    );
    assert.equal(
      newGreenhouseQueryPlan(previous, [], undefined, ["web", "backend"])[0]
        .query,
      "web",
    );
  } finally {
    await f.close();
  }
});

test("short custom rotations keep every selected extra search term and employment scope", () => {
  const scope = ["full_time", "contract"] as const;
  const plan = newGreenhouseQueryPlan(
    undefined,
    ["APIs", "integrations", "JavaScript"],
    [...scope],
    ["web"],
  );
  assert.deepEqual(
    plan.map(({ query, employmentTypes }) => ({ query, employmentTypes })),
    [
      { query: "APIs", employmentTypes: [...scope] },
      { query: "web", employmentTypes: ["contract"] },
      { query: "web", employmentTypes: [...scope] },
      { query: "integrations", employmentTypes: [...scope] },
      { query: "JavaScript", employmentTypes: [...scope] },
    ],
  );
});
