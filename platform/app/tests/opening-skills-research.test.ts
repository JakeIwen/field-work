import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openingResearchTool,
  publishOpeningResearch,
  validateOpeningResearch,
} from "../server/opening-workflow.js";
import { validatePullResearch } from "../server/opening-pull/research.js";
import type { PullCandidate } from "../server/greenhouse-pull-records.js";
import { contextTool } from "../server/context-tools.js";
import { HttpError } from "../server/storage.js";
import { openingSkillListLimits } from "../shared/opening-skills.js";
import type { Opening } from "../shared/types.js";
import { legacyOpening, legacyTask } from "./fixtures/legacy-records.js";
import {
  card,
  posting,
  research,
  fixture,
} from "./fixtures/greenhouse-pull-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const candidate: PullCandidate = {
  id: "candidate-1",
  runId: "run-1",
  card: card("1"),
  posting: posting(card("1")),
  state: "reviewing",
};

const rejectsSkills = (error: unknown) =>
  error instanceof HttpError &&
  error.status === 422 &&
  /skills.*required.*preferred.*60.*anyOf.*20.*1–10.*single-line.*60/.test(
    error.message,
  );

function saveResearch(store: ReturnType<typeof fixture>["store"]) {
  const data = research(candidate);
  store.put(
    "task",
    "research",
    legacyTask({
      id: "research",
      preset: "opening-research",
      status: "running",
      threadId: "research-thread",
      importUrl: candidate.card.url,
    }),
  );
  contextTool(store, "research-thread", "save_opening_research", data);
  const opening = publishOpeningResearch(store, "research");
  assert.ok(opening);
  return { opening, data };
}

test("research tool requires bounded classified skill lists and any-of groups and saving binds them to the Opening hash", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const openingSchema = openingResearchTool.inputSchema.properties.opening;
  assert.ok(openingSchema.required.includes("skills"));
  const schema = openingSchema.properties.skills;
  assert.deepEqual(schema.required, ["required", "preferred", "anyOf"]);
  assert.equal(schema.additionalProperties, false);
  for (const list of [
    schema.properties.required,
    schema.properties.preferred,
  ]) {
    assert.equal(list.maxItems, openingSkillListLimits.items);
    assert.equal(list.items.maxLength, openingSkillListLimits.length);
    assert.equal(list.items.minLength, 1);
    assert.equal(new RegExp(list.items.pattern).test("Node\nJS"), false);
  }
  const groups = schema.properties.anyOf;
  assert.equal(groups.maxItems, openingSkillListLimits.groups);
  assert.equal(groups.items.minItems, 2);
  assert.equal(groups.items.maxItems, openingSkillListLimits.groupMembers);
  assert.deepEqual(groups.items.items, schema.properties.required.items);
  const { opening, data } = saveResearch(f.store);
  assert.deepEqual(opening.skills?.anyOf, [["PostgreSQL", "MySQL"]]);
  assert.deepEqual(opening.skills, data.opening.skills);
  assert.equal(opening.skillsSourceHash, opening.hash);
});

test("research rejects malformed classified skills with actionable 422 feedback", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const data = research(candidate);
  for (const skills of [
    { required: ["Node\nJS"], preferred: [] },
    { required: Array.from({ length: 61 }, () => "React"), preferred: [] },
    { required: [42], preferred: [] },
    { required: [], preferred: ["x".repeat(61)] },
    { required: [], preferred: ["   "] },
    { required: [] },
    null,
  ])
    assert.throws(
      () =>
        validateOpeningResearch(f.store, {
          ...data,
          opening: { ...data.opening, skills },
        }),
      rejectsSkills,
    );
  assert.doesNotThrow(() =>
    validateOpeningResearch(f.store, {
      ...data,
      opening: { ...data.opening, skills: undefined },
    }),
  );
  assert.doesNotThrow(() =>
    validateOpeningResearch(f.store, {
      ...data,
      opening: { ...data.opening, skills: { required: [], preferred: [] } },
    }),
  );
});

test("research save rejects malformed any-of shapes with 422 and accepts explicit empty groups", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const { data } = saveResearch(f.store);
  for (const anyOf of [
    "Go",
    ["Go"],
    [[]],
    [Array(11).fill("Go")],
    Array.from({ length: 21 }, () => ["Go", "Python"]),
    [["Go", "Python\nJava"]],
    [["Go", "x".repeat(61)]],
  ])
    assert.throws(
      () =>
        contextTool(f.store, "research-thread", "save_opening_research", {
          ...data,
          opening: {
            ...data.opening,
            skills: { ...data.opening.skills, anyOf },
          },
        }),
      rejectsSkills,
    );
  assert.doesNotThrow(() =>
    contextTool(f.store, "research-thread", "save_opening_research", {
      ...data,
      opening: {
        ...data.opening,
        skills: { ...data.opening.skills, anyOf: [] },
      },
    }),
  );
});

test("merging advertisements replaces stale or missing skills and preserves fresh skills", async (t) => {
  for (const source of ["stale", "fresh", "missing"]) {
    await t.test(source, async (t) => {
      const f = fixture();
      t.after(() => f.close());
      const skills = {
        required: ["Python"],
        anyOf: [["Postgres", "MySQL"]],
        preferred: ["Redis"],
      };
      f.store.put(
        "custom_opening",
        "existing",
        legacyOpening({
          id: "existing",
          company_id: "example",
          company: "Example",
          title: candidate.card.title,
          url: "https://example.com/careers/1",
          postingStatus: "open",
          hash: "existing-hash",
          ...(source === "missing"
            ? {}
            : {
                skills,
                skillsSourceHash:
                  source === "fresh" ? "existing-hash" : "old-hash",
              }),
        }),
      );
      const { opening, data } = saveResearch(f.store);
      assert.equal(opening.id, "existing");
      assert.equal(opening.hash, "existing-hash");
      assert.equal(opening.skillsSourceHash, opening.hash);
      assert.deepEqual(
        opening.skills,
        source === "fresh" ? skills : data.opening.skills,
      );
    });
  }
});

test("new pull research requires skills even though legacy direct research remains accepted", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const data = research(candidate);
  assert.throws(
    () =>
      validatePullResearch(
        f.store,
        { ...data, opening: { ...data.opening, skills: undefined } },
        candidate,
      ),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 422 &&
      /skills.required\/skills.preferred/.test(error.message),
  );
  const validated = validatePullResearch(f.store, data, candidate);
  assert.deepEqual(validated.opening.skills, data.opening.skills);
  assert.equal(validated.opening.description, candidate.posting?.text);
});

test("GET /api/state retains classified skills and their posting-hash binding", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opening-skills-state-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    const skills = {
      required: ["React"],
      anyOf: [["Postgres", "MySQL"]],
      preferred: ["Go"],
    };
    workspace.store.put(
      "custom_opening",
      "skills-state",
      legacyOpening({
        id: "skills-state",
        title: "Software Engineer",
        url: candidate.card.url,
        requirements: "React and either Postgres or MySQL. Go is a plus.",
        skills,
        hash: "posting-hash",
        skillsSourceHash: "posting-hash",
      }),
    );
    const response = await workspace.get("/api/state");
    assert.equal(response.status, 200);
    const state = (await response.json()) as { openings: Opening[] };
    const opening = state.openings.find((o) => o.id === "skills-state");
    assert.ok(opening);
    assert.deepEqual(opening.skills, skills);
    assert.equal(opening.skillsSourceHash, opening.hash);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
