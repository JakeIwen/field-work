import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  fixture,
  at,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { greenhouseQueries } from "../server/greenhouse-query-plan.js";
import { creationOptionFields } from "../server/task-kinds/task-creation-fields.js";
import { prepareOpeningResearch } from "../server/opening-workflow.js";
import { draftPath } from "../server/bundles.js";
import { searchUrl, parseSearch } from "../server/greenhouse-search.js";

const guidance = {
  employmentScope: ["full_time" as const],
  instructions:
    "Include contract and fractional roles alongside W-2. Preserve hourly pay and verify weekly hours.",
  searchTerms: ["contract", "fractional", "part time"],
};

function assertPullReviewPolicy(captured: string) {
  assert.match(
    captured,
    /Use skip_greenhouse_opening to exclude required travel above 5% of working time/,
  );
  assert.match(
    captured,
    /monthly multi-day client visits, frequent travel or regular travel to customer sites/,
  );
  assert.match(
    captured,
    /unstated or vague travel, do not exclude on their own; record them as remote-fit restrictions/,
  );
  assert.match(
    captured,
    /a programming language absent from the languages on the resume defines the role/,
  );
  assert.match(
    captured,
    /Go Engineer or Senior Rust Developer.*a Go-based build tool/,
  );
  assert.match(
    captured,
    /Keep roles where the missing language is one of several working languages alongside one on the resume, preferred or nice-to-have, or incidental/,
  );
  assert.match(
    captured,
    /Outside that core-language exception, do not silently discard Staff\/Lead roles, unfamiliar but learnable languages, libraries, frameworks or tools/,
  );
}

test("saved guidance changes discovery and reaches captured research; resume keeps it after edits", async () => {
  const f = fixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: guidance,
    });
    const run = f.manager.start(3, "guided");
    assert.deepEqual(
      run.queryPlan!.slice(0, 6).map((cursor) => cursor.query),
      [
        "contract",
        "software engineer",
        "fractional",
        "full stack",
        "part time",
        "backend",
      ],
    );
    assert.ok(
      greenhouseQueries.every((term) =>
        run.queryPlan!.some((cursor) => cursor.query === term),
      ),
    );
    await advanceUntil(f, () => f.store.list("task").length === 1);
    assert.deepEqual(f.calls[0], { query: "contract", page: 1 });
    const candidate = f.manager
      .ledger(run.id)
      .candidates.find((row) => row.taskId)!;
    const task = {
      ...f.store.get("task", candidate.taskId!)!,
      id: randomUUID(),
      ...creationOptionFields({ greenhouseContext: { run, candidate } }),
      posting: {
        text: candidate.posting!.text,
        fetchedAt: candidate.posting!.fetchedAt,
      },
    };
    prepareOpeningResearch(f.store, task);
    const captured = readFileSync(
      draftPath(f.store, task.id, "HARVEST-INSTRUCTIONS.md"),
      "utf8",
    );
    assert.ok(captured.includes(guidance.instructions));
    assertPullReviewPolicy(captured);
    f.manager.action(run.id, "pause");
    const pausedPlan = f.manager.latest()!.queryPlan;
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        ...guidance,
        instructions: "Different next pull",
        searchTerms: ["consultant"],
      },
    });
    f.setTime(at + 86400000);
    await f.restart();
    f.manager.action(run.id, "resume");
    assert.deepEqual(f.manager.state()!.guidance, guidance);
    assert.deepEqual(f.manager.latest()!.queryPlan, pausedPlan);
    assert.equal(f.manager.start(3, "guided").id, run.id);
    assert.equal(
      readFileSync(
        draftPath(f.store, task.id, "HARVEST-INSTRUCTIONS.md"),
        "utf8",
      ),
      captured,
    );
    f.manager.action(run.id, "stop");
    const next = f.manager.start(3, "next");
    assert.equal(next.guidance!.instructions, "Different next pull");
    assert.deepEqual(next.guidance!.searchTerms, ["consultant"]);
    assert.equal(next.queryPlan![0].query, "consultant");
  } finally {
    await f.close();
  }
});

test("old end dates never expire captured guidance or restricted employment searches", async () => {
  const f = fixture();
  try {
    const saved = {
      ...guidance,
      employmentScope: ["full_time", "contract", "part_time"] as const,
      throughDate: "2026-09-28",
    };
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        ...saved,
        employmentScope: [...saved.employmentScope],
      },
    });
    f.setTime(Date.parse("2026-10-29T06:00:00Z"));
    const run = f.manager.start();
    assert.deepEqual(run.guidance, {
      ...guidance,
      employmentScope: ["full_time", "contract", "part_time"],
    });
    assert.ok(
      run.queryPlan!.some((query) => query.employmentTypes?.[0] === "contract"),
    );
    assert.ok(
      run.queryPlan!.some(
        (query) => query.employmentTypes?.[0] === "part_time",
      ),
    );
  } finally {
    await f.close();
  }
});

test("guidance API validates, preserves settings, rejects stale edits and persists across restart/export", async () => {
  const savedGuidance = {
    ...guidance,
    employmentScope: ["full_time", "contract", "part_time"],
  };
  const root = mkdtempSync(path.join(os.tmpdir(), "pull-guidance-"));
  let workspace = await openFixtureWorkspace(root);
  try {
    const state = await (await workspace.get("/api/state")).json();
    const version = state.settings.version;
    for (const invalid of [
      null,
      { ...guidance, instructions: 2 },
      { ...guidance, employmentScope: [] },
      { ...guidance, employmentScope: undefined },
      { ...guidance, employmentScope: ["contract", "contract"] },
      { ...guidance, employmentScope: "contract" },
      { ...guidance, employmentScope: ["freelance"] },
      { ...guidance, employmentScope: null },
      { ...guidance, instructions: "x".repeat(4001) },
      { ...guidance, searchTerms: ["bad\nterm"] },
      { ...guidance, searchTerms: Array(9).fill("contract") },
    ]) {
      const response = await workspace.post("/api/greenhouse/guidance", {
        expectedVersion: version,
        guidance: invalid,
      });
      assert.equal(response.status, 400, await response.text());
    }
    const response = await workspace.post("/api/greenhouse/guidance", {
      expectedVersion: version,
      guidance: { ...savedGuidance, throughDate: "not a date" },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.deepEqual(saved.greenhouseGuidance, savedGuidance);
    assert.equal(saved.timezone, state.settings.timezone);
    assert.equal(saved.version, version + 1);
    const stale = await workspace.post("/api/greenhouse/guidance", {
      expectedVersion: version,
      guidance: { ...guidance, instructions: "stale" },
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(
      workspace.store.personalExport().records.settings[0].greenhouseGuidance,
      savedGuidance,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    assert.deepEqual(
      (await (await workspace.get("/api/state")).json()).settings
        .greenhouseGuidance,
      savedGuidance,
    );
    assert.equal(
      (await (await workspace.get("/api/state")).json()).greenhousePull,
      null,
      "saving guidance never starts a pull",
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom terms preserve Greenhouse search constraints and exact response identity", () => {
  const url = new URL(searchUrl("fractional & contract", 2));
  assert.equal(url.searchParams.get("query"), "fractional & contract");
  assert.deepEqual(url.searchParams.getAll("employment_type[]"), [
    "full_time",
    "part_time",
    "contract",
    "temporary",
  ]);
  assert.deepEqual(url.searchParams.getAll("work_type[]"), ["remote"]);
  assert.equal(url.searchParams.get("date_posted"), "past_ten_days");
  const body = JSON.stringify({
    component: "jobs",
    url: url.href,
    props: { page: 2, moreResultsAvailable: false, jobPosts: [] },
  });
  assert.equal(parseSearch(body, "fractional & contract", 2).more, false);
  assert.throws(() => parseSearch(body, "software", 2));
  for (const term of ["", "\ncontract", "x".repeat(101)])
    assert.throws(() => searchUrl(term, 1));
});
