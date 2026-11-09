import test from "node:test";
import assert from "node:assert/strict";
import {
  newGreenhouseQueryPlan,
  greenhouseQueries,
  greenhouseSearchCoverage,
} from "../server/greenhouse-query-plan.js";
import {
  greenhouseSearchIdentity,
  regularGreenhouseEmploymentTypes,
  type GreenhouseSearch,
} from "../shared/greenhouse-search.js";
import { validateGreenhouseGuidance } from "../server/opening-pull/guidance.js";
import { recordGreenhouseSearchPage } from "../server/greenhouse-pull-discovery.js";
import { searchUrl } from "../server/greenhouse-search.js";
import { GreenhouseLimit } from "../server/greenhouse-source.js";
import {
  fixture,
  at,
  card,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";

const guidance = {
  instructions: "Check weekly hours and contract duration.",
  searchTerms: ["developer tools"],
  employmentScope: ["full_time", "contract", "part_time", "temporary"] as const,
};

function result(
  search: GreenhouseSearch,
  page: number,
  ids: string[],
  more = false,
) {
  return {
    ...search,
    page,
    cards: ids.map(card),
    more,
    url: searchUrl(search.query, page, search.employmentTypes),
    at: new Date(at).toISOString(),
    status: 200,
  };
}

test("each selected employment type adds every software query with a singleton filter alongside regular and text searches", () => {
  const plan = newGreenhouseQueryPlan(undefined, guidance.searchTerms, [
    ...guidance.employmentScope,
  ]);
  assert.equal(plan.length, greenhouseQueries.length * 4 + 1);
  assert.deepEqual(
    plan.slice(0, 5).map((search) => greenhouseSearchIdentity(search).label),
    [
      "developer tools",
      "software engineer · Contract",
      "software engineer · Part time",
      "software engineer · Temporary",
      "software engineer",
    ],
  );
  for (const query of greenhouseQueries) {
    const searches = plan.filter((search) => search.query === query);
    assert.deepEqual(
      searches.map((search) => search.employmentTypes),
      [
        ["contract"],
        ["part_time"],
        ["temporary"],
        [...guidance.employmentScope],
      ],
    );
    for (const search of searches)
      assert.deepEqual(
        new URL(
          searchUrl(search.query, 1, search.employmentTypes),
        ).searchParams.getAll("employment_type[]"),
        search.employmentTypes,
      );
  }
  assert.deepEqual(plan[0].employmentTypes, [...guidance.employmentScope]);
  const keys = plan.map((search) => greenhouseSearchIdentity(search).key);
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(
    greenhouseSearchIdentity({ query: "software engineer · Contract" }).key,
    greenhouseSearchIdentity(plan[1]).key,
  );
});

test("employment guidance requires a nonempty unique scope and saves canonical label order", () => {
  assert.deepEqual(
    validateGreenhouseGuidance({
      ...guidance,
      employmentScope: ["temporary", "part_time", "full_time", "contract"],
    }).employmentScope,
    [...guidance.employmentScope],
  );
  for (const employmentScope of [
    undefined,
    [],
    ["contract", "contract"],
    ["Contract"],
    ["unknown"],
    null,
    {},
    "contract",
  ])
    assert.throws(
      () => validateGreenhouseGuidance({ ...guidance, employmentScope }),
      /Employment scope/,
    );
});

test("identical terms in regular and scoped searches retain separate coverage and shared candidate provenance", async () => {
  const f = fixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        ...guidance,
        searchTerms: [],
        employmentScope: ["full_time", "contract"],
      },
    });
    const run = f.manager.start();
    const scoped = run.queryPlan![0];
    const regular = run.queryPlan![1];
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      queryPlan: [scoped, regular],
    });
    recordGreenhouseSearchPage(
      f.store,
      f.manager.latest()!,
      result(scoped, 1, ["1"], true),
      at,
    );
    const same = f.manager.ledger(run.id).candidates[0];
    f.store.put("greenhouse_pull_candidate", same.id, {
      ...same,
      state: "reviewing",
      taskId: "existing-review",
    });
    const afterScoped = f.manager.latest()!;
    recordGreenhouseSearchPage(
      f.store,
      afterScoped,
      result(regular, 1, ["1"], true),
      at,
    );
    recordGreenhouseSearchPage(
      f.store,
      f.manager.latest()!,
      result(scoped, 2, ["2"]),
      at,
    );
    const saved = f.manager.latest()!;
    assert.deepEqual(
      saved.pages.map((page) => page.employmentTypes),
      [["contract"], ["full_time", "contract"], ["contract"]],
    );
    const duplicate = f.manager.ledger(run.id).candidates[0];
    assert.equal(duplicate.state, "reviewing");
    assert.equal(duplicate.taskId, "existing-review");
    assert.deepEqual(duplicate.discoveredBy, [
      greenhouseSearchIdentity(scoped).key,
      greenhouseSearchIdentity(regular).key,
    ]);
    assert.deepEqual(
      greenhouseSearchCoverage(saved)
        .slice(0, 2)
        .map((search) => [
          greenhouseSearchIdentity(search).label,
          search.pages,
        ]),
      [
        ["software engineer · Contract", 2],
        ["software engineer · Contract, Full time", 1],
      ],
    );
  } finally {
    await f.close();
  }
});

test("discovery rejects a repeated page or a search advancing ahead of its round", async () => {
  const f = fixture();
  try {
    const run = f.manager.start();
    const first = run.queryPlan![0];
    recordGreenhouseSearchPage(f.store, run, result(first, 1, ["1"], true), at);
    const saved = f.manager.latest()!;
    for (const page of [1, 2])
      assert.throws(
        () =>
          recordGreenhouseSearchPage(
            f.store,
            saved,
            result(first, page, ["2"]),
            at,
          ),
        /Unexpected search page/,
      );
    assert.deepEqual(f.manager.latest(), saved);
  } finally {
    await f.close();
  }
});

test("restricted searches rotate by page and retry the exact filter after restart", async () => {
  let limited = false;
  const calls: (GreenhouseSearch & { page: number })[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      const search = { query, employmentTypes };
      calls.push({ ...search, page });
      if (employmentTypes?.[0] === "part_time" && page === 2 && !limited) {
        limited = true;
        throw new GreenhouseLimit("429", new Date(at + 120000).toISOString());
      }
      const response = result(search, page, [String(calls.length)], page < 3);
      response.cards[0].title = "Proofreader";
      return response;
    },
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        ...guidance,
        searchTerms: [],
        employmentScope: ["full_time", "contract", "part_time"],
      },
    });
    const run = f.manager.start(10);
    await advanceUntil(f, () => f.manager.state()!.status === "cooldown");
    assert.deepEqual(
      calls
        .slice(0, run.queryPlan!.length)
        .map((search) => [greenhouseSearchIdentity(search).key, search.page]),
      run.queryPlan!.map((search) => [greenhouseSearchIdentity(search).key, 1]),
    );
    assert.deepEqual(
      calls
        .slice(-2)
        .map((search) => [greenhouseSearchIdentity(search).label, search.page]),
      [
        ["software engineer · Contract", 2],
        ["software engineer · Part time", 2],
      ],
    );
    const count = calls.length;
    const snapshot = f.manager.latest()!;
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: { ...guidance, employmentScope: ["temporary"] },
    });
    await f.restart();
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.equal(calls.length, count);
    f.setTime(at + 120001);
    await advanceUntil(f, () => calls.length === count + 1);
    assert.deepEqual(calls.at(-1), calls.at(-2));
    assert.deepEqual(f.manager.latest()!.guidance, snapshot.guidance);
    assert.deepEqual(
      f.manager
        .state()!
        .searches!.slice(0, 3)
        .map((search) => search.pages),
      [2, 2, 1],
    );
  } finally {
    await f.close();
  }
});

test("employment guidance keeps its restricted searches on later pulls", async () => {
  const f = fixture();
  try {
    const saved = {
      ...guidance,
      employmentScope: [...guidance.employmentScope],
    };
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: saved,
    });
    const first = f.manager.start();
    assert.deepEqual(first.guidance!.employmentScope, saved.employmentScope);
    f.manager.action(first.id, "stop");
    f.setTime(at + 86400000);
    const next = f.manager.start();
    assert.deepEqual(next.guidance!.employmentScope, saved.employmentScope);
    assert.equal(next.queryPlan!.length, greenhouseQueries.length * 4 + 1);
    assert.equal(next.queryPlan![0].query, "developer tools");
    assert.ok(
      next.queryPlan!.some(
        (search) => search.employmentTypes?.[0] === "contract",
      ),
    );
    assert.deepEqual(
      f.store.settings().greenhouseGuidance!.employmentScope,
      saved.employmentScope,
    );
  } finally {
    await f.close();
  }
});

test("legacy captured plans keep all-type searches and plain-text provenance without rewriting saved guidance", async () => {
  const f = fixture();
  try {
    const { employmentScope: _, ...legacyGuidance } = guidance;
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: legacyGuidance,
    });
    const run = f.manager.start();
    assert.deepEqual(run.guidance!.employmentScope, ["full_time"]);
    const legacyPlan = run.queryPlan!.map(
      ({ employmentTypes: _, ...search }) => search,
    );
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      guidance: legacyGuidance,
      queryPlan: legacyPlan,
    });
    await f.restart();
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.deepEqual(f.calls[0], { query: "developer tools", page: 1 });
    assert.deepEqual(f.manager.latest()!.guidance, legacyGuidance);
    assert.deepEqual(f.manager.state()!.guidance!.employmentTypes, []);
    assert.deepEqual(f.manager.ledger(run.id).candidates[0].discoveredBy, [
      "developer tools",
    ]);
  } finally {
    await f.close();
  }
});
