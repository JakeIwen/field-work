import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { card } from "./fixtures/greenhouse-pull-fixture.js";
import { greenhouseCompanyDisposition } from "../server/opening-pull/card-triage.js";
import { greenhouseSearchTermPoolLimit } from "../shared/greenhouse-guidance.js";

import { defaultGreenhousePullPolicy } from "../shared/greenhouse-policy.js";

const route = "/api/greenhouse/guidance";
const guidance = {
  instructions: "Check working hours",
  searchTerms: [],
  employmentScope: ["contract"],
};

test("combined guidance save uses one version bump and keeps omitted company/pool values", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "guidance-combined-"));
  const http = await openFixtureWorkspace(root);
  try {
    const old = http.store.settings();
    const candidate = {
      id: "queued",
      runId: "run",
      card: card("1"),
      state: "discovered" as const,
    };
    assert.equal(
      greenhouseCompanyDisposition(http.store, candidate),
      undefined,
    );
    const response = await http.post(route, {
      expectedVersion: old.version,
      guidance,
      policy: { ...defaultGreenhousePullPolicy, freshnessDays: 4 },
      excludedCompanies: [" Example ", "example", "Other"],
      searchTermPool: [
        " Custom term ",
        "custom TERM",
        "React",
        "API ENGINEER",
        "New skill",
      ],
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.version, old.version + 1);
    assert.deepEqual(saved.greenhouseExcludedCompanies, ["example", "Other"]);
    assert.deepEqual(saved.greenhouseSearchTermPool, [
      "Custom term",
      "New skill",
    ]);
    assert.deepEqual(saved.greenhouseGuidance, guidance);
    assert.equal(saved.timezone, old.timezone);
    assert.equal(saved.greenhousePolicy.freshnessDays, 4);
    assert.equal(
      greenhouseCompanyDisposition(http.store, candidate)?.state,
      "excluded",
    );
    assert.equal(
      greenhouseCompanyDisposition(http.store, {
        ...candidate,
        state: "reviewing",
      }),
      undefined,
    );
    const next = await http.post(route, {
      expectedVersion: saved.version,
      guidance: { ...guidance, instructions: "Changed" },
    });
    assert.equal(next.status, 200);
    const unchanged = await next.json();
    assert.equal(unchanged.version, saved.version + 1);
    assert.deepEqual(unchanged.greenhousePolicy, saved.greenhousePolicy);
    assert.deepEqual(
      unchanged.greenhouseExcludedCompanies,
      saved.greenhouseExcludedCompanies,
    );
    assert.deepEqual(
      unchanged.greenhouseSearchTermPool,
      saved.greenhouseSearchTermPool,
    );
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale combined saves mutate nothing and the older company endpoint still works", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "guidance-stale-"));
  const http = await openFixtureWorkspace(root);
  try {
    const initial = http.store.settings();
    const saved = await http.post(route, {
      expectedVersion: initial.version,
      guidance,
      excludedCompanies: ["Example"],
      searchTermPool: ["Custom term"],
    });
    assert.equal(saved.status, 200);
    const before = http.store.personalExport().records;
    const stale = await http.post(route, {
      expectedVersion: initial.version,
      guidance: { ...guidance, instructions: "stale" },
      excludedCompanies: [],
      searchTermPool: [],
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(http.store.personalExport().records, before);
    const response = await http.post("/api/greenhouse/excluded-companies", {
      expectedVersion: http.store.settings().version,
      companies: [],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(http.store.settings().greenhouseExcludedCompanies, []);
    assert.deepEqual(http.store.settings().greenhouseSearchTermPool, [
      "Custom term",
    ]);
    assert.deepEqual(http.store.settings().greenhouseGuidance, guidance);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined save validates every field before mutation and bounds normalized pool terms", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "guidance-pool-validation-"));
  const http = await openFixtureWorkspace(root);
  try {
    const settings = http.store.settings();
    for (const fields of [
      { policy: null },
      ...[
        { freshnessDays: 0 },
        { freshnessDays: 11 },
        { freshnessDays: 1.5 },
        { travelCapPercent: -1 },
        { travelCapPercent: 101 },
        { excludeMissingLanguage: "yes" },
        { reuseReviews: null },
        { deferralReuseHours: 0 },
        { deferralReuseHours: 721 },
        { titleTriage: "false" },
        { regularSearchTerms: [] },
        { regularSearchTerms: ["backend", " BACKEND "] },
        { regularSearchTerms: ["bad\nterm"] },
        { unknownField: true },
      ].map((change) => ({
        policy: { ...defaultGreenhousePullPolicy, ...change },
      })),
      { searchTermPool: null },
      { searchTermPool: "term" },
      { searchTermPool: [1] },
      { searchTermPool: [""] },
      { searchTermPool: ["bad\nterm"] },
      { searchTermPool: ["x".repeat(101)] },
      {
        searchTermPool: Array.from(
          { length: greenhouseSearchTermPoolLimit + 1 },
          (_, index) => `Custom ${index}`,
        ),
      },
      { excludedCompanies: null },
      { excludedCompanies: ["bad\ncompany"] },
    ]) {
      const response = await http.post(route, {
        expectedVersion: settings.version,
        guidance,
        ...fields,
      });
      assert.equal(response.status, 400, await response.text());
      assert.deepEqual(http.store.settings(), settings);
      assert.deepEqual(http.store.list("greenhouse_guidance_history"), []);
    }
    const custom = Array.from(
      { length: greenhouseSearchTermPoolLimit },
      (_, index) => `Custom ${index}`,
    );
    const response = await http.post(route, {
      expectedVersion: settings.version,
      guidance,
      searchTermPool: [...custom, "REACT", " custom 0 "],
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).greenhouseSearchTermPool, custom);
    const cleared = await http.post(route, {
      expectedVersion: http.store.settings().version,
      guidance: { ...guidance, instructions: "" },
      excludedCompanies: [],
      searchTermPool: [],
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).greenhouseSearchTermPool, []);
    assert.equal(
      http.store.list("greenhouse_guidance_history").length,
      1,
      "clearing instructions does not add empty history",
    );
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});
