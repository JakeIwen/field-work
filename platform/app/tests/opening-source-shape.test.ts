import test from "node:test";
import assert from "node:assert/strict";
import { parseOpenings, salaryBands } from "../server/importer.js";
import { openingsMarkdown } from "../server/careers/reconcile.js";
import { parse as parseSkillFields } from "../server/opening-skills-fields.js";
import { openingSkillGroups } from "../shared/opening-skills.js";
import { openingAssessmentDetails } from "../shared/opening-assessments.js";

const researchedOpening = {
  company_id: "example",
  job_id: "123",
  company: "Example",
  title: "Senior Engineer",
  url: "https://example.com/jobs/123",
  location: "Remote in approved US states",
  compensation: "$150,000–$180,000 base",
  technical_fit: "High",
  remote_fit: "Medium",
  wlb_outlook: "Uncertain",
  why: "Relevant API ownership.",
  concerns: "Confirm state eligibility and on-call.",
  requirements: "Develop software.",
  wlb_evidence: "Team hours unknown.",
  first_seen: "2026-09-20",
  last_confirmed_open: "2026-09-20",
  postingStatus: "open",
  first_published: "2026-09-15T14:00:00Z",
  deadline: "2026-10-02",
  dateSources: {
    firstPublishedAt: "https://example.com/jobs/123",
    deadline: "https://example.com/jobs/123",
  },
  assessmentDetails: {
    technicalFit: "React and API ownership align; Go is new.",
    remoteFit: "Only approved US states; travel policy unclear.",
    wlbOutlook: "On-call exists but frequency and normal hours are unknown.",
  },
  skills: {
    required: ["React"],
    anyOf: [
      ["Go", "Python", "Java"],
      ["Postgres", "MySQL"],
    ],
    preferred: ["Redis"],
  },
  listSummary: {
    location: "US remote; state restrictions",
    technicalFit: "High",
    wlbOutlook: "Uncertain",
    compensation: "USD $150k–$180k base",
  },
};

test("source Markdown round-trip retains categories, full assessments, concise summaries and dated evidence", () => {
  const original = researchedOpening;
  const markdown = openingsMarkdown(
    [original],
    "2026-09-20T12:00:00Z",
    "research/scans/example",
  );
  assert.match(
    markdown,
    /Required skill groups:\*\* Go or Python or Java; Postgres or MySQL/,
  );
  const parsed = parseOpenings(markdown)[0];
  assert.equal(parsed.technical_fit, "High");
  assert.equal(parsed.remote_fit, "Medium");
  assert.equal(parsed.wlb_outlook, "Uncertain");
  assert.deepEqual(parsed.assessmentDetails, original.assessmentDetails);
  assert.deepEqual(parsed.listSummary, original.listSummary);
  assert.deepEqual(parsed.skills, original.skills);
  assert.deepEqual(openingSkillGroups(parsed), {
    required: ["React"],
    anyOf: [
      ["Go", "Java", "Python"],
      ["MySQL", "PostgreSQL"],
    ],
    preferred: ["Redis"],
  });
  assert.equal(parsed.skillsSourceHash, parsed.hash);
  assert.equal(parsed.first_published, original.first_published);
  assert.equal(parsed.deadline, original.deadline);
  assert.deepEqual(parsed.dateSources, original.dateSources);
  assert.equal(parsed.assessmentSourceHash, parsed.hash);
  assert.equal(parsed.listSummarySourceHash, parsed.hash);
  assert.equal(
    openingAssessmentDetails({
      ...parsed,
      hash: "changed",
      technical_fit: "Unknown",
    }).technicalFit,
    "Unknown",
  );
});

test("annual salary filtering excludes hourly and weekly gross but keeps annual pay alongside work hours or monthly perks", () => {
  assert.deepEqual(
    salaryBands(
      "USD $150/hour, up to 25 hours/week; maximum stated weekly gross is $3,750.",
    ),
    [],
  );
  const bands = salaryBands(
    "Annual base $175,000–$245,000; eligible at 30 hours/week; $2,000 monthly allowance.",
  );
  assert.deepEqual(
    bands.map((b) => [b.min, b.max, b.basis]),
    [[175000, 245000, "published base"]],
  );
  assert.deepEqual(salaryBands("$9,000 per month base"), []);
});

test("source skill fields preserve empty lists without changing legacy content hashes", () => {
  const original = {
    company_id: "example",
    job_id: "123",
    company: "Example",
    title: "Engineer",
    url: "https://example.com/jobs/123",
    compensation: "Unknown",
    requirements: "React and Python",
  };
  const render = (extra: object = {}) =>
    openingsMarkdown(
      [{ ...original, ...extra }],
      "2026-10-29T12:00:00Z",
      "research/scans/example",
    );
  const legacy = parseOpenings(render())[0];
  assert.equal(legacy.skills, undefined);
  const empty = parseOpenings(
    render({ skills: { required: [], preferred: [] } }),
  )[0];
  assert.deepEqual(empty.skills, { required: [], preferred: [], anyOf: [] });
  assert.equal(empty.skillsSourceHash, empty.hash);
  assert.equal(empty.hash, legacy.hash);
  const requiredOnly = parseOpenings(
    render() + "* **Required skills:**  React, , Postgres,  \n",
  )[0];
  assert.deepEqual(requiredOnly.skills, {
    required: ["React", "Postgres"],
    preferred: [],
    anyOf: [],
  });
  const preferredOnly = parseOpenings(
    render() + "* **Preferred skills:** Go, , Python\n",
  )[0];
  assert.deepEqual(preferredOnly.skills, {
    required: [],
    preferred: ["Go", "Python"],
    anyOf: [],
  });
  const invalid = parseOpenings(
    render() + "* **Required skills:** , , " + "x".repeat(61) + "\n",
  )[0];
  assert.deepEqual(invalid.skills, { required: [], preferred: [], anyOf: [] });
  const groupsOnly = parseOpenings(
    render() + "* **Required skill groups:** Go or Python; Postgres or MySQL\n",
  )[0];
  assert.deepEqual(groupsOnly.skills, {
    required: [],
    preferred: [],
    anyOf: [
      ["Go", "Python"],
      ["Postgres", "MySQL"],
    ],
  });
  assert.equal(groupsOnly.hash, legacy.hash);
  assert.equal(requiredOnly.hash, legacy.hash);
  assert.equal(preferredOnly.hash, legacy.hash);
});

test("source skill groups ignore unknown and empty entries and bound groups, members and name lengths", () => {
  for (const value of [
    "",
    "unknown",
    "Go\nPython",
    "; unknown; ; " + "x".repeat(61),
  ])
    assert.deepEqual(parseSkillFields({ "Required skill groups": value }), {
      required: [],
      preferred: [],
      anyOf: [],
    });
  assert.deepEqual(
    parseSkillFields({
      "Required skill groups":
        "unknown or Postgres or MySQL; " + "x".repeat(61) + " or Go",
    }),
    {
      required: [],
      preferred: [],
      anyOf: [["Postgres", "MySQL"], ["Go"]],
    },
  );
  const members = Array.from({ length: 11 }, (_, i) => `Tool ${i}`);
  const groups = Array.from({ length: 21 }, () => members.join(" or "));
  assert.deepEqual(
    parseSkillFields({ "Required skill groups": groups.join("; ") }),
    {
      required: [],
      preferred: [],
      anyOf: Array.from({ length: 20 }, () => members.slice(0, 10)),
    },
  );
});

test("source writer omits stale or invalid skills and retains unbound or current classifications", () => {
  const original = {
    company_id: "example",
    job_id: "123",
    company: "Example",
    title: "Engineer",
    url: "https://example.com/jobs/123",
    compensation: "Unknown",
    hash: "current",
    skills: {
      required: ["React"],
      anyOf: [["Postgres", "MySQL"]],
      preferred: ["Go"],
    },
  };
  const render = (extra: object = {}) =>
    openingsMarkdown(
      [{ ...original, ...extra }],
      "2026-10-29T12:00:00Z",
      "research/scans/example",
    );
  assert.match(render(), /Required skills:\*\* React/);
  assert.match(render(), /Required skill groups:\*\* Postgres or MySQL/);
  assert.doesNotMatch(
    render({ skills: { required: [], preferred: [], anyOf: [] } }),
    /Required skill groups/,
  );
  assert.match(
    render({ skillsSourceHash: "current" }),
    /Preferred skills:\*\* Go/,
  );
  assert.doesNotMatch(
    render({ skillsSourceHash: "stale" }),
    /Required skills|Preferred skills|Required skill groups/,
  );
  assert.doesNotMatch(
    render({ skills: { required: [42], preferred: [] } }),
    /Required skills|Preferred skills|Required skill groups/,
  );
});
