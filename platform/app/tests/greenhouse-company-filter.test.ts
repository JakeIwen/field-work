import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import {
  fixture,
  advanceUntil,
  card,
  posting,
  at,
} from "./fixtures/greenhouse-pull-fixture.js";
import { greenhouseCompanyFilterLimits } from "../shared/greenhouse-company-filter.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import { searchUrl } from "../server/greenhouse-source.js";

const endpoint = "/api/greenhouse/excluded-companies";
test("company filter API validates and version-checks private settings and survives export/restart", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "greenhouse-company-filter-"),
  );
  let workspace = await openFixtureWorkspace(root);
  try {
    const old = workspace.store.settings();
    for (const companies of [
      null,
      "Example",
      [5],
      ["\nExample\nOther"],
      ["!!!"],
      ["a".repeat(greenhouseCompanyFilterLimits.length + 1)],
      Array(greenhouseCompanyFilterLimits.count + 1).fill("Example"),
    ])
      assert.equal(
        (
          await workspace.post(endpoint, {
            expectedVersion: old.version,
            companies,
          })
        ).status,
        400,
      );
    const response = await workspace.post(endpoint, {
      expectedVersion: old.version,
      companies: ["  Example  ", "EXAMPLE", "", "other-board"],
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.deepEqual(saved.greenhouseExcludedCompanies, [
      "EXAMPLE",
      "other-board",
    ]);
    assert.equal(saved.version, old.version + 1);
    assert.deepEqual(saved.fitCriteria, old.fitCriteria);
    assert.equal(
      (
        await workspace.post(endpoint, {
          expectedVersion: old.version,
          companies: [],
        })
      ).status,
      409,
    );
    assert.deepEqual(
      workspace.store.personalExport().records.settings[0]
        .greenhouseExcludedCompanies,
      saved.greenhouseExcludedCompanies,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    const state = await (await workspace.get("/api/state")).json();
    assert.deepEqual(
      state.settings.greenhouseExcludedCompanies,
      saved.greenhouseExcludedCompanies,
    );
    assert.equal(state.greenhousePull, null);
    assert.equal(
      (
        await workspace.post(endpoint, {
          expectedVersion: saved.version,
          companies: [],
        })
      ).status,
      200,
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery excludes exact normalized company names and board tokens but not substrings or saved Openings", async () => {
  const cards = [
    { ...card("1"), company: "Méta, Inc.", board: "different" },
    { ...card("2"), company: "Other Company", board: "TARGET-board" },
    { ...card("3"), company: "Metabase", board: "metabase" },
    { ...card("4"), company: "Meta, Inc.", board: "saved" },
  ];
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      cards,
      more: false,
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: ["meta inc", "target board", "meta"],
    });
    f.store.put(
      "custom_opening",
      "saved",
      legacyOpening({
        id: "saved",
        url: cards[3].url,
        company: cards[3].company,
        title: "Saved Opening",
      }),
    );
    const run = f.manager.start();
    await f.manager.tick();
    const candidates = f.manager.ledger(run.id).candidates;
    assert.deepEqual(
      candidates.map((candidate) => candidate.state),
      ["excluded", "excluded", "discovered", "existing"],
    );
    assert.equal(
      candidates[0].reason,
      "Company filter: “Méta, Inc.” is on your excluded companies list.",
    );
    assert.equal(f.manager.state()!.excluded, 2);
    assert.equal(f.store.list("task").length, 0);
    assert.equal(f.calls.filter((call) => call.posting).length, 0);
    assert.equal(
      f.store.get("custom_opening", "saved")?.title,
      "Saved Opening",
    );
  } finally {
    await f.close();
  }
});

test("live company filter skips queued candidates without changing a review already running", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(3);
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: ["EXAMPLE"],
    });
    await advanceUntil(f, () => f.manager.state()!.excluded === 2);
    assert.equal(f.store.list("task").length, 1);
    assert.equal(f.calls.filter((call) => call.posting).length, 1);
    const review = f.manager
      .ledger(run.id)
      .candidates.find((candidate) => candidate.state === "reviewing");
    assert.ok(review);
    f.finish();
    await f.manager.tick();
    assert.equal(f.manager.state()!.added, 1);
  } finally {
    await f.close();
  }
});

test("a company added during posting retrieval is checked again before research starts", async () => {
  let release!: () => void;
  const f = fixture({
    posting: async (candidate) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return posting(candidate);
    },
  });
  try {
    f.manager.start();
    await f.manager.tick();
    const pending = f.manager.tick();
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: ["example"],
    });
    release();
    await pending;
    assert.equal(f.store.list("task").length, 0);
    assert.equal(f.manager.state()!.excluded, 1);
  } finally {
    await f.close();
  }
});
