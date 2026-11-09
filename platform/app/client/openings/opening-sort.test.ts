import test from "node:test";
import assert from "node:assert/strict";
import {
  sortOpenings,
  openingSort,
  openingAddedDate,
  openingPostedDate,
} from "./opening-sort.js";
import type { Opening } from "../../shared/types.js";
const role = (id: string, values: Partial<Opening> = {}) =>
  ({
    id,
    company: "Example",
    title: "Engineer",
    ...values,
  }) as Opening;
test("assessment sorts use categories and keep uncertainty last in both directions", () => {
  const roles = ["Unknown", "Medium", "Uncertain", "Low", "High"].map((value) =>
    role(value, {
      technical_fit: value,
      remote_fit: value,
      wlb_outlook: value,
    }),
  );
  for (const dimension of ["technical", "remote", "wlb"]) {
    assert.deepEqual(
      sortOpenings(roles, `${dimension}-high`).map((o) => o.id),
      ["High", "Medium", "Low", "Uncertain", "Unknown"],
    );
    assert.deepEqual(
      sortOpenings(roles, `${dimension}-low`).map((o) => o.id),
      ["Low", "Medium", "High", "Uncertain", "Unknown"],
    );
  }
  assert.deepEqual(
    roles.map((o) => o.id),
    ["Unknown", "Medium", "Uncertain", "Low", "High"],
  );
});
test("opportunity sorting uses natural names and stable ties without mutating source order", () => {
  const roles = [
    role("c", { company: "Zulu" }),
    role("b", { company: "Alpha", title: "Engineer 10" }),
    role("a", { company: "Alpha", title: "Engineer 2" }),
    role("u", { company: "Aardvark" }),
  ];
  assert.deepEqual(
    sortOpenings(roles, "docs-first").map((o) => o.id),
    ["u", "a", "b", "c"],
  );
  assert.deepEqual(
    sortOpenings(roles, "company-desc").map((o) => o.id),
    ["c", "a", "b", "u"],
  );
  assert.deepEqual(
    sortOpenings(roles, "company")
      .filter((o) => o.company === "Alpha")
      .map((o) => o.id),
    ["a", "b"],
  );
  assert.deepEqual(
    roles.map((o) => o.id),
    ["c", "b", "a", "u"],
  );
  assert.equal(openingSort("obsolete saved setting"), "docs-first");
  assert.equal(openingSort("priority"), "docs-first");
});
test("retired deadline sorts normalize to the default without changing deadline data", () => {
  const roles = [
    role("later", { deadline: "2026-10-01" }),
    role("soon", { deadline: "2026-09-21" }),
  ];
  for (const key of ["deadline", "deadline-desc"]) {
    assert.equal(openingSort(key), "docs-first");
    assert.deepEqual(
      sortOpenings(roles, key),
      sortOpenings(roles, "docs-first"),
    );
  }
  assert.equal(roles[1].deadline, "2026-09-21");
});

test("newest added uses recorded timestamps, falls back to first seen and leaves unknowns last", () => {
  const roles = [
    role("none"),
    role("seen", { first_seen: "2026-09-19" }),
    role("imported", {
      firstImportedAt: "2026-09-20T10:00:00Z",
      first_seen: "2026-09-01",
    }),
    role("created", { createdAt: "2026-09-20T12:00:00Z" }),
  ];
  assert.deepEqual(
    sortOpenings(roles, "newest").map((o) => o.id),
    ["created", "imported", "seen", "none"],
  );
  assert.deepEqual(
    sortOpenings(roles, "oldest").map((o) => o.id),
    ["seen", "imported", "created", "none"],
  );
  assert.equal(openingAddedDate(roles[1]).approximate, true);
  assert.equal(openingAddedDate(roles[2]).approximate, false);
});
test("posted sorting uses original publication only, preserves date-only values and keeps unknown dates last both ways", () => {
  const roles = [
    role("unknown", {
      first_seen: "2026-09-20",
      sourceDate: "2026-09-20",
      updated_at: "2026-09-20",
    }),
    role("early", { first_published: "2026-09-01" }),
    role("later", { first_published: "2026-09-19T23:30:00-04:00" }),
    role("invalid", { first_published: "unknown" }),
  ];
  assert.equal(openingPostedDate(roles[0]), null);
  assert.equal(openingPostedDate(roles[1]), "2026-09-01");
  assert.equal(openingPostedDate(roles[3]), null);
  assert.deepEqual(
    sortOpenings(roles, "posted-newest").map((o) => o.id),
    ["later", "early", "invalid", "unknown"],
  );
  assert.deepEqual(
    sortOpenings(roles, "posted-oldest").map((o) => o.id),
    ["early", "later", "invalid", "unknown"],
  );
});
test("autofill sorting puts generated scripts first, fewest items to finish first", () => {
  const roles = [
    role("no-script-docs"),
    role("three-left"),
    role("none-left-b"),
    role("no-script"),
    role("none-left-a"),
  ];
  assert.deepEqual(
    sortOpenings(
      roles,
      "autofill-ready",
      {
        "no-script-docs": 1,
        "three-left": 1,
        "none-left-b": 1,
        "none-left-a": 1,
      },
      { "three-left": 3, "none-left-b": 0, "none-left-a": 0 },
    ).map((o) => o.id),
    ["none-left-a", "none-left-b", "three-left", "no-script-docs", "no-script"],
  );
  assert.equal(openingSort("autofill-ready"), "autofill-ready");
});

test("skills sorts rank percent and counts, then default order, with skill-less postings always last", () => {
  const roles = [
    role("none", { requirements: "Build products" }),
    role("unmatched", { requirements: "Java, Docker" }),
    role("one-full", { requirements: "React" }),
    role("two-full", { requirements: "React, JS" }),
    role("two-half", { requirements: "React, JS, Java, Docker" }),
    role("two-half-docs", {
      requirements: "React, JS, Java, Docker",
    }),
    role("two-half-company", {
      company: "Alpha",
      requirements: "React, JS, Java, Docker",
    }),
    role("one-half", { requirements: "React, Java" }),
  ];
  const known = ["React", "JS"];
  const docs = { "two-half-docs": 1, none: 1 };
  const sorted = (key: string) =>
    sortOpenings(roles, key, docs, {}, known).map((o) => o.id);
  assert.deepEqual(sorted("skills-percent"), [
    "two-full",
    "one-full",
    "two-half-docs",
    "two-half-company",
    "two-half",
    "one-half",
    "unmatched",
    "none",
  ]);
  assert.deepEqual(sorted("skills-count"), [
    "two-full",
    "two-half-docs",
    "two-half-company",
    "two-half",
    "one-full",
    "one-half",
    "unmatched",
    "none",
  ]);
  assert.equal(
    sortOpenings(roles, "skills-percent").at(-1)?.id,
    "none",
    "older backends without knownSkills remain usable",
  );
});
