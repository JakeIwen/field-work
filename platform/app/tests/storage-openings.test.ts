import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Opening } from "../shared/types.js";
import type { OpeningValidation } from "../shared/opening-availability.js";
import { Store } from "../server/storage.js";
import { readOpenings } from "../server/storage-openings.js";
import { samePostingUrls } from "../server/job-posting.js";
import { legacyOpening } from "./fixtures/legacy-records.js";

// Keep the pre-index implementation as an independent output/order oracle.
function previousReadOpenings(store: Store): Opening[] {
  const rows = new Map(store.list("cache_opening").map((o) => [o.id, o]));
  for (const o of store.list("custom_opening")) {
    const source =
      rows.get(o.id) ??
      [...rows.values()].find((s) => samePostingUrls(s.url, o.url));
    if (source) rows.delete(source.id);
    const newerSource =
      source &&
      Date.parse(source.lastCheckedAt ?? source.sourceDate ?? "") >
        Date.parse(o.lastCheckedAt ?? o.sourceDate ?? "");
    rows.set(o.id, {
      ...o,
      ...(newerSource ? source : {}),
      id: o.id,
      company_id: o.company_id,
      company: o.company,
      personalOpening: true,
      // The company contact overlay is authoritative independently of vacancy refresh.
      contactInfo: o.contactInfo ?? source?.contactInfo,
      contact: o.contact ?? source?.contact,
    });
  }
  const validations = new Map(
    store.list("opening_validation").map((v) => [v.id, v]),
  );
  return [...rows.values()].map((o) => {
    const validation = validations.get(o.id);
    // Old stored JSON may retain retired fields; reads must not republish them.
    const record = { ...o };
    delete record["priority"];
    return {
      ...record,
      validation:
        validation && samePostingUrls(validation.url, o.url)
          ? validation
          : undefined,
    };
  });
}

type Fixture = {
  cache: Opening[];
  custom: Opening[];
  validations: OpeningValidation[];
};

const url = (job: string) => `https://example.test/jobs/${job}`;
const validation = (id: string, postingUrl: string): OpeningValidation => ({
  id,
  url: postingUrl,
  status: "closed",
  checkedAt: "2026-10-29T12:00:00Z",
  reason: "Synthetic check",
  evidenceHashes: [],
  runId: "fixture",
});

function edgeFixture(): Fixture {
  const source = (id: string, job: string, date: string) =>
    legacyOpening({
      id,
      url: url(job),
      title: id,
      lastCheckedAt: date,
      contactInfo: `Contact from ${id}`,
      priority: "retired",
    });
  const custom = (id: string, job: string) =>
    legacyOpening({
      id,
      url: url(job) + "?utm_source=custom#posting",
      company_id: `company-${id}`,
      company: `Company ${id}`,
      lastCheckedAt: "2026-10-01",
    });
  return {
    cache: [
      source("source-first", "shared", "2026-10-20"),
      source("source-second", "shared", "2026-10-19"),
      source("id-match", "id-before", "2026-10-18"),
      source("still-source", "still", "2026-10-17"),
      source("invalid-source", "invalid", "2026-10-16"),
      source("change-source", "old-key", "2026-10-15"),
    ].map((o) =>
      o.id === "invalid-source" ? { ...o, url: "invalid URL" } : o,
    ),
    custom: [
      custom("id-match", "shared"),
      custom("first-custom", "shared"),
      custom("second-custom", "shared"),
      { ...custom("third-custom", "shared"), contactInfo: "Custom contact" },
      custom("id-follower", "id-before"),
      {
        ...custom("change-source", "new-key"),
        title: "New URL",
        lastCheckedAt: "2026-10-28",
      },
      custom("old-key-follower", "old-key"),
      custom("new-key-follower", "new-key"),
      { ...custom("invalid-custom", "invalid"), url: "invalid URL" },
      { ...custom("invalid-custom-again", "invalid"), url: "invalid URL" },
      { ...custom("invalid-source", "invalid"), url: "invalid URL" },
      custom("no-match", "only-custom"),
    ],
    validations: [
      validation("second-custom", url("shared") + "?source=validation"),
      validation("third-custom", url("other")),
      validation("id-follower", url("id-before")),
      validation("invalid-custom", "invalid URL"),
    ],
  };
}

function randomizedFixture(seed: number): Fixture {
  let state = seed;
  const random = (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  const urls = [
    url("one"),
    url("one") + "/?utm_source=test#fragment",
    "https://EXAMPLE.test/jobs/one?gh_src=fixture",
    url("one") + "?gh_jid=1",
    url("one") + "?gh_jid=2",
    url("two") + "?b=2&a=1",
    url("two") + "?a=1&source=test&b=2",
    "http://example.test/jobs/one",
    url("ONE"),
    "not a URL",
    "",
    "https://127.0.0.1/jobs/one",
    "http://localhost/jobs/one",
    "https://[::1]/jobs/one",
    "ftp://example.test/jobs/one",
    "https://user:password@example.test/jobs/one",
    "https://example.test:4317/jobs/one",
  ];
  const dates = [null, "", "invalid", "2026-10-01", "2026-10-28"];
  const opening = (id: string) =>
    legacyOpening({
      id,
      url: urls[random(urls.length)],
      title: `Title ${random(100)}`,
      company_id: `company-${random(4)}`,
      company: `Company ${random(4)}`,
      sourceDate: dates[random(dates.length)],
      lastCheckedAt: random(2) ? dates[random(dates.length)] : undefined,
      contactInfo: random(2) ? `Contact ${random(100)}` : undefined,
      contact: random(2)
        ? {
            companyId: "contact-company",
            contactInfo: "Synthetic contact",
            contactType: "recruiting",
            sourceUrl: url("contact"),
            checkedAt: null,
          }
        : undefined,
      priority: "retired",
      validation: validation("embedded", url("old-validation")),
    });
  const cache = Array.from({ length: random(25) }, (_, i) =>
    opening(`source-${i}`),
  );
  const custom = Array.from({ length: random(30) }, (_, i) =>
    opening(
      cache.length && random(3) === 0
        ? cache[random(cache.length)].id
        : `custom-${i}`,
    ),
  );
  return {
    cache,
    custom,
    validations: [...cache, ...custom]
      .filter(() => random(2))
      .map((o) =>
        validation(o.id, random(2) ? o.url : urls[random(urls.length)]),
      ),
  };
}

function installFixture(store: Store, fixture: Fixture) {
  store.transaction(() => {
    for (const kind of [
      "cache_opening",
      "custom_opening",
      "opening_validation",
    ] as const)
      for (const row of store.list(kind)) store.remove(kind, row.id);
    for (const row of fixture.cache) store.put("cache_opening", row.id, row);
    for (const row of fixture.custom) store.put("custom_opening", row.id, row);
    for (const row of fixture.validations)
      store.put("opening_validation", row.id, row);
  });
}

test("indexed Opening merges match the prior scan, including duplicate order and invalid URLs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opening-projection-"));
  const store = new Store(root, path.join(root, ".data"));
  try {
    const fixtures = [
      { cache: [], custom: [], validations: [] },
      edgeFixture(),
      ...Array.from({ length: 250 }, (_, i) => randomizedFixture(i + 1)),
    ];
    for (const [i, fixture] of fixtures.entries()) {
      installFixture(store, fixture);
      const before = JSON.stringify([
        store.list("cache_opening"),
        store.list("custom_opening"),
        store.list("opening_validation"),
      ]);
      const expected = previousReadOpenings(store);
      const actual = readOpenings(store);
      assert.deepEqual(actual, expected, `fixture ${i}`);
      assert.equal(
        JSON.stringify(actual),
        JSON.stringify(expected),
        `fixture ${i} bytes`,
      );
      assert.equal(
        JSON.stringify([
          store.list("cache_opening"),
          store.list("custom_opening"),
          store.list("opening_validation"),
        ]),
        before,
        `fixture ${i} leaves stored records unchanged`,
      );
      if (i === 1) checkEdgeOutput(actual);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function checkEdgeOutput(openings: Opening[]) {
  assert.deepEqual(
    openings.map((o) => o.id),
    [
      "still-source",
      "second-custom",
      "third-custom",
      "id-follower",
      "old-key-follower",
      "new-key-follower",
      "invalid-custom",
      "invalid-custom-again",
      "invalid-source",
      "no-match",
    ],
  );
  const byId = new Map(openings.map((o) => [o.id, o]));
  assert.equal(byId.get("second-custom")?.title, "source-second");
  assert.equal(byId.get("third-custom")?.title, "source-first");
  assert.equal(byId.get("third-custom")?.contactInfo, "Custom contact");
  assert.equal(byId.get("third-custom")?.company, "Company third-custom");
  assert.equal(byId.get("id-follower")?.title, "id-match");
  assert.equal(byId.get("new-key-follower")?.title, "New URL");
  assert.equal(byId.get("second-custom")?.validation?.status, "closed");
  assert.equal(byId.get("third-custom")?.validation, undefined);
  assert.equal(byId.get("id-follower")?.validation?.status, "closed");
  assert.equal(byId.get("invalid-custom")?.validation, undefined);
}
