import assert from "node:assert/strict";
import test from "node:test";
import { pullTravelExclusion } from "../server/opening-pull/travel.js";
import { classifyPullScreen } from "../server/opening-pull/metric-classifiers.js";
import {
  fixture,
  posting,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { legacyOpening } from "./fixtures/legacy-records.js";

const excluded = [
  "This position requires up to 25% travel.",
  "You must travel up to 10% to customer sites.",
  "10-20% travel is required for client meetings.",
  "Travel: 15%",
  "Expect approximately 30% of the time traveling.",
  "Less than 10% travel is expected.",
  "Travel requirements: less than 10% of working time.",
  "Travel required (up to 25%).",
  "Travel between 0 and 10 percent of your time.",
  "Expect 5%–10% domestic and international travel.",
  "Travel: 10 to 5%",
  "Travel up to 5.1% of working time.",
  "Spend 20 percent of your time on business travel.",
  "Travel is required up to 10% of the time.",
  "Travel is expected to be up to 25% of the time.",
  "Travel will comprise 20% of your work time.",
  "More than 5% travel is required.",
  "Travel over 5% of working time.",
];
const allowed = [
  "Build software in a remote-first team.",
  "Up to 5% travel is required.",
  "Travel: less than 5%",
  "No more than 5% travel is expected.",
  "Not over 5% travel.",
  "Travel no more than 5% of working time.",
  "0–5% travel",
  "Travel between 0 and 5 percent of working time.",
  "Travel: 0%",
  "You may need to travel occasionally.",
  "Frequent travel to customer sites is required.",
  "We meet for an annual three-day team gathering.",
  "Reduce travel costs by 30%.",
  "Grew bookings 40% in the travel industry.",
  "Build travel software. Receive 5% equity and a 401(k) match of 6%.",
  "5% equity; travel as needed; 401(k) match 6%.",
  "Travel is optional up to 25% of the time.",
  "Optional travel up to 25%.",
  "Opportunities to travel up to 25% of your time.",
  "We reimburse 100% of travel expenses.",
  "Travel is 30% of our revenue.",
  "Our platform makes travel 30% cheaper.",
  "Travel up to 5%; 10% annual bonus.",
  "Travel up to 5%, and 20% of compensation is a bonus.",
  "Travel. Up to 25% bonus.",
  "Travel\n15% annual bonus",
];

test("travel screening uses a role travel percentage's maximum bound above five", () => {
  for (const text of excluded) {
    const reason = pullTravelExclusion(text);
    assert.ok(reason, text);
    assert.ok(reason.includes(text), reason);
    assert.deepEqual(classifyPullScreen(reason), [{ metric: "travelPercent" }]);
  }
  for (const text of allowed)
    assert.equal(pullTravelExclusion(text), undefined, text);
  assert.match(
    pullTravelExclusion("Build software. Travel up to 10%; 6% match.") ?? "",
    /“Travel up to 10%”/,
  );
});

test("pull screens fetched postings before task creation and retains matched evidence", async () => {
  const f = fixture({
    posting: async (card) => ({ ...posting(card), text: excluded[0] }),
  });
  try {
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.state()?.excluded === 3);
    assert.equal(f.store.list("task").length, 0);
    assert.ok(
      f.manager
        .ledger(run.id)
        .candidates.every(
          (candidate) => candidate.reason === pullTravelExclusion(excluded[0]),
        ),
    );
    assert.equal(f.store.list("greenhouse_review_memory").length, 0);
  } finally {
    await f.close();
  }
});

test("cached discovered postings are screened while finishing without refetching", async () => {
  const f = fixture();
  try {
    const run = f.manager.start();
    await f.manager.tick();
    const candidate = f.manager.ledger(run.id).candidates[0];
    f.store.put("greenhouse_pull_candidate", candidate.id, {
      ...candidate,
      posting: { ...posting(candidate.card), text: excluded[0] },
    });
    f.manager.action(run.id, "stop");
    await f.manager.tick();
    assert.equal(
      f.store.get("greenhouse_pull_candidate", candidate.id)?.reason,
      pullTravelExclusion(excluded[0]),
    );
    assert.equal(f.store.list("task").length, 0);
    assert.ok(!f.calls.some((call) => call.posting));
  } finally {
    await f.close();
  }
});

for (const status of ["handoff", "queued"] as const)
  test(`a ${status} review is screened again before the agent starts`, async () => {
    const f = fixture();
    try {
      const run = f.manager.start(1);
      await advanceUntil(f, () => f.store.list("task").length === 1);
      const candidate = f.manager
        .ledger(run.id)
        .candidates.find((row) => row.taskId);
      assert.ok(candidate?.posting && candidate.taskId);
      const task = f.store.get("task", candidate.taskId);
      assert.ok(task);
      f.store.put("task", task.id, { ...task, status });
      f.store.put("greenhouse_pull_candidate", candidate.id, {
        ...candidate,
        posting: { ...candidate.posting, text: excluded[0] },
      });
      await f.manager.tick();
      assert.equal(
        f.store.get("greenhouse_pull_candidate", candidate.id)?.state,
        "excluded",
      );
      assert.deepEqual(f.store.get("task", task.id), { ...task, status });
    } finally {
      await f.close();
    }
  });

test("already-started reviews can settle without the new screen changing them", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    const candidate = f.manager
      .ledger(run.id)
      .candidates.find((row) => row.taskId);
    assert.ok(candidate?.posting);
    f.store.put("greenhouse_pull_candidate", candidate.id, {
      ...candidate,
      posting: {
        ...candidate.posting,
        text: `${candidate.posting.text}\n${excluded[0]}`,
      },
    });
    f.finish();
    await advanceUntil(f, () => f.manager.state()?.added === 1);
    assert.equal(
      f.store.get("greenhouse_pull_candidate", candidate.id)?.state,
      "added",
    );
  } finally {
    await f.close();
  }
});

test("saved Openings stay byte-identical and are deduplicated before travel screening", async () => {
  const f = fixture({
    posting: async (card) => ({ ...posting(card), text: excluded[0] }),
  });
  try {
    const saved = legacyOpening({
      id: "saved-travel",
      url: "https://job-boards.greenhouse.io/example/jobs/1",
      company: "Example",
      title: "Software Engineer 1",
      description: excluded[0],
    });
    f.store.put("custom_opening", saved.id, saved);
    const before = JSON.stringify(f.store.get("custom_opening", saved.id));
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.state()?.excluded === 2);
    assert.equal(
      f.manager
        .ledger(run.id)
        .candidates.find((candidate) => candidate.card.id === "1")?.state,
      "existing",
    );
    assert.equal(
      JSON.stringify(f.store.get("custom_opening", saved.id)),
      before,
    );
  } finally {
    await f.close();
  }
});
