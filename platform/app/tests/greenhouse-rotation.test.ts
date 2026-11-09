import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  advanceUntil,
  at,
  card,
  posting,
} from "./fixtures/greenhouse-pull-fixture.js";
import {
  greenhouseQueries,
  currentGreenhouseQuery,
} from "../server/greenhouse-query-plan.js";
import {
  greenhouseSearchIdentity,
  type GreenhouseEmploymentType,
} from "../shared/greenhouse-search.js";
import { searchUrl, GreenhouseLimit } from "../server/greenhouse-source.js";

function pageResult(
  query: string,
  page: number,
  employmentTypes: GreenhouseEmploymentType[] | undefined,
  count = 1,
  more = page < 3,
) {
  const group = greenhouseQueries.indexOf(query);
  return {
    query,
    page,
    more,
    status: 200,
    at: new Date(at).toISOString(),
    employmentTypes,
    url: searchUrl(query, page, employmentTypes),
    cards: Array.from({ length: count }, (_, index) =>
      card(String(group * 1000 + page * 100 + index)),
    ),
  };
}
const running = (f: ReturnType<typeof fixture>) =>
  f.manager.state()!.reviews!.filter((review) => review.status === "running")
    .length;
const backlog = (f: ReturnType<typeof fixture>) =>
  f.store
    .list("greenhouse_pull_candidate")
    .filter((candidate) => candidate.state === "discovered").length;

test("six reviews start before unsearched terms and discovery refills only below six queued candidates", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) =>
      pageResult(query, page, employmentTypes, 8),
  });
  try {
    f.manager.start(20);
    await f.manager.tick();
    assert.equal(f.manager.latest()!.pages.length, 1);
    await advanceUntil(f, () => running(f) === 6);
    assert.equal(backlog(f), 2);
    assert.equal(f.manager.latest()!.pages.length, 1);
    await f.manager.tick();
    assert.equal(f.manager.latest()!.pages.length, 2);
    assert.equal(backlog(f), 10);
    assert.equal(
      running(f),
      6,
      "search can run while every review slot is full",
    );
    for (let step = 0; step < 3; step++) await f.manager.tick();
    assert.equal(
      f.manager.latest()!.pages.length,
      2,
      "no search at or above low water",
    );
    for (let review = 0; review < 3; review++) f.finish(true);
    await advanceUntil(
      f,
      () => f.manager.state()!.excluded === 3 && running(f) === 6,
    );
    assert.equal(backlog(f), 7);
    await f.manager.tick();
    assert.equal(f.manager.latest()!.pages.length, 2);
    for (let review = 0; review < 2; review++) f.finish(true);
    await advanceUntil(
      f,
      () => f.manager.state()!.excluded === 5 && running(f) === 6,
    );
    assert.equal(backlog(f), 5);
    await f.manager.tick();
    assert.equal(f.manager.latest()!.pages.length, 3);
    assert.equal(f.manager.latest()!.pages[2].page, 1);
  } finally {
    await f.close();
  }
});

test("review rotation skips unsearched groups rather than starving an earlier backlog", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) =>
      pageResult(query, page, employmentTypes, 8, false),
  });
  try {
    const run = f.manager.start(20);
    await advanceUntil(f, () => running(f) === 6);
    await f.manager.tick();
    f.finish(true, "100");
    await advanceUntil(f, () => f.store.list("task").length === 7);
    assert.equal(
      f.manager.ledger(run.id).candidates.find((c) => c.card.id === "1100")!
        .state,
      "reviewing",
    );
    await advanceUntil(f, () => running(f) === 6);
    f.finish(true, "101");
    await advanceUntil(f, () => f.store.list("task").length === 8);
    assert.equal(
      f.manager.ledger(run.id).candidates.find((c) => c.card.id === "106")!
        .state,
      "reviewing",
    );
    assert.equal(f.manager.latest()!.pages.length, 2);
  } finally {
    await f.close();
  }
});

test("one-page search steps persist round-robin coverage across restart and drop exhausted searches", async () => {
  const calls: { query: string; page: number }[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      calls.push({ query, page });
      const result = pageResult(
        query,
        page,
        employmentTypes,
        1,
        query !== greenhouseQueries[1] && page < 3,
      );
      result.cards[0].title = "Proofreader";
      return result;
    },
  });
  try {
    const run = f.manager.start();
    await f.manager.tick();
    assert.deepEqual(calls, [{ query: greenhouseQueries[0], page: 1 }]);
    await f.restart();
    f.manager.action(run.id, "resume");
    await advanceUntil(f, () => f.manager.latest()!.status === "exhausted");
    assert.deepEqual(
      calls,
      [1, 2, 3].flatMap((page) =>
        greenhouseQueries
          .filter((query) => page === 1 || query !== greenhouseQueries[1])
          .map((query) => ({ query, page })),
      ),
    );
    assert.equal(f.store.list("task").length, 0);
  } finally {
    await f.close();
  }
});

test("a search cooldown retries the same term and page in the saved round", async () => {
  let limited = false;
  const calls: { query: string; page: number }[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      calls.push({ query, page });
      if (page === 2 && !limited) {
        limited = true;
        throw new GreenhouseLimit(
          "HTTP 429",
          new Date(at + 120000).toISOString(),
        );
      }
      const result = pageResult(query, page, employmentTypes);
      result.cards[0].title = "Proofreader";
      return result;
    },
  });
  try {
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.latest()!.status === "cooldown");
    assert.deepEqual(calls.at(-1), { query: greenhouseQueries[0], page: 2 });
    await f.restart();
    f.manager.action(run.id, "resume");
    f.setTime(at + 120001);
    await advanceUntil(f, () => calls.length === greenhouseQueries.length + 2);
    assert.deepEqual(calls.at(-1), calls.at(-2));
    assert.equal(
      currentGreenhouseQuery(f.manager.latest()!),
      greenhouseQueries[1],
    );
    assert.equal(f.manager.latest()!.page, 2);
  } finally {
    await f.close();
  }
});

test("new runs rotate their first term while duplicate start requests keep their saved plan", async () => {
  const f = fixture();
  try {
    const first = f.manager.start(10, "first");
    assert.equal(currentGreenhouseQuery(first), "software engineer");
    f.manager.action(first.id, "stop");
    const second = f.manager.start(10, "second");
    assert.equal(currentGreenhouseQuery(second), "full stack");
    assert.equal(f.manager.start(10, "first").id, first.id);
    assert.equal(f.manager.latest()!.id, second.id);
    f.manager.action(second.id, "stop");
    assert.equal(currentGreenhouseQuery(f.manager.start()), "backend");
  } finally {
    await f.close();
  }
});

test("legacy pulls resume their original term and page before joining round-robin coverage", async () => {
  const calls: { query: string; page: number }[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      calls.push({ query, page });
      return pageResult(query, page, employmentTypes, 1, false);
    },
  });
  try {
    const fresh = f.manager.start();
    const { queryPlan: _plan, reviewCursor: _cursor, ...legacy } = fresh;
    f.store.put("greenhouse_pull_run", fresh.id, {
      ...legacy,
      queryIndex: 1,
      page: 3,
      pages: [
        {
          query: "full stack",
          page: 1,
          ids: ["example:1"],
          more: false,
          at: new Date(at).toISOString(),
          status: 200,
        },
        {
          query: "full-stack",
          page: 1,
          ids: ["example:2"],
          more: true,
          at: new Date(at).toISOString(),
          status: 200,
        },
        {
          query: "full-stack",
          page: 2,
          ids: ["example:3"],
          more: true,
          at: new Date(at).toISOString(),
          status: 200,
        },
      ],
    });
    await f.restart();
    f.manager.action(fresh.id, "resume");
    await f.manager.tick();
    assert.deepEqual(calls, [{ query: "full-stack", page: 3 }]);
    assert.deepEqual(
      f.manager.latest()!.queryPlan!.map((query) => query.query),
      ["full stack", "full-stack", "software", "software developer"],
    );
    assert.equal(currentGreenhouseQuery(f.manager.latest()!), "software");
    assert.equal(f.manager.latest()!.page, 1);
  } finally {
    await f.close();
  }
});

test("cross-query duplicates add provenance without changing an active review", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      ...pageResult(query, page, employmentTypes),
      cards: [
        card("1"),
        card(String((greenhouseQueries.indexOf(query) + 1) * 100 + page)),
      ],
    }),
  });
  try {
    const run = f.manager.start(3);
    await advanceUntil(f, () => f.store.list("task").length === 1);
    const original = f.manager
      .ledger(run.id)
      .candidates.find((c) => c.card.id === "1")!;
    assert.deepEqual(original.discoveredBy, [
      greenhouseSearchIdentity(run.queryPlan![0]).key,
    ]);
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 2);
    const same = f.manager
      .ledger(run.id)
      .candidates.find((c) => c.card.id === "1")!;
    assert.deepEqual(
      same.discoveredBy,
      run
        .queryPlan!.slice(0, 2)
        .map((search) => greenhouseSearchIdentity(search).key),
    );
    assert.equal(same.state, "reviewing");
    assert.equal(same.taskId, original.taskId);
    assert.equal(f.store.get("task", same.taskId!)!.status, "running");
  } finally {
    await f.close();
  }
});

test("posting cooldown retries its saved candidate before review rotation advances", async () => {
  const fetched: string[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes) =>
      pageResult(query, page, employmentTypes, 2),
    posting: async (candidate) => {
      fetched.push(candidate.id);
      if (fetched.length === 1)
        throw new GreenhouseLimit(
          "Posting HTTP 429",
          new Date(at + 120000).toISOString(),
        );
      return posting(candidate);
    },
  });
  try {
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.state()!.status === "cooldown");
    const pending = f.manager.latest()!.retryCandidateId;
    assert.ok(pending);
    await f.restart();
    f.manager.action(run.id, "resume");
    f.setTime(at + 120001);
    await f.manager.tick();
    assert.deepEqual(fetched, ["100", "100"]);
    assert.equal(f.manager.latest()!.retryCandidateId, undefined);
    assert.equal(
      f.manager
        .ledger(run.id)
        .candidates.find((candidate) => candidate.id === pending)!.state,
      "reviewing",
    );
  } finally {
    await f.close();
  }
});
