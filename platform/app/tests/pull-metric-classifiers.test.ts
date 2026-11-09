import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPullScreen,
  classifyPullReview,
} from "../server/opening-pull/metric-classifiers.js";
import { pullTitleExclusion } from "../server/opening-pull/title-triage.js";
import { greenhouseCardDisposition } from "../server/opening-pull/card-triage.js";
import { pullDateDisposition } from "../server/opening-pull/dates.js";
import { pullTechnologyExclusion } from "../server/opening-pull/screen.js";
import { recordGreenhousePublishedOpening } from "../server/greenhouse-pull-publication.js";
import { normalizeFitCriteria } from "../shared/fit-criteria.js";
import {
  fixture,
  card,
  posting,
  at,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { metricRun, metricCandidate } from "./fixtures/pull-metrics.js";
import { legacyOpening } from "./fixtures/legacy-records.js";

const metric = (reason: string | undefined) => {
  assert.ok(reason);
  return classifyPullScreen(reason);
};

test("title metrics track each real excluded title term and the non-software rule", () => {
  const criteria = normalizeFitCriteria({
    titleExcludeTerms: ["Data Engineer", "SRE"],
  });
  for (const term of criteria.titleExcludeTerms)
    assert.deepEqual(metric(pullTitleExclusion(term, criteria)), [
      { metric: "titleTerm", detail: term },
    ]);
  assert.deepEqual(metric(pullTitleExclusion("Proofreader")), [
    { metric: "titleRole" },
  ]);
});

test("screen classification follows actual card, date and publication reason producers", async () => {
  const f = fixture();
  try {
    const candidate = metricCandidate("run", "1", { state: "discovered" });
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: ["Example"],
    });
    assert.deepEqual(
      metric(greenhouseCardDisposition(f.store, candidate)?.reason),
      [{ metric: "company" }],
    );
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: [],
    });
    assert.deepEqual(
      metric(
        greenhouseCardDisposition(
          f.store,
          {
            ...candidate,
            card: { ...candidate.card, firstPublished: "2026-09-01" },
          },
          [],
          at,
        )?.reason,
      ),
      [{ metric: "searchDate" }],
    );
    const run = metricRun("run"),
      source = posting(candidate.card);
    assert.deepEqual(
      metric(pullDateDisposition(run, { ...source, raw: {} }, at)?.reason),
      [{ metric: "missingDate" }],
    );
    assert.deepEqual(
      metric(
        pullDateDisposition(
          run,
          { ...source, raw: { first_published: "2026-01-01" } },
          at,
        )?.reason,
      ),
      [{ metric: "publicationDate" }],
    );
    const saved = legacyOpening({
      id: "saved",
      url: candidate.card.url,
      company: "Example",
      title: candidate.card.title,
    });
    f.store.put("custom_opening", saved.id, saved);
    assert.deepEqual(
      metric(greenhouseCardDisposition(f.store, candidate)?.reason),
      [{ metric: "duplicate" }],
    );
    recordGreenhousePublishedOpening(
      f.store,
      run,
      candidate,
      source,
      saved,
      "jobId",
      () => [],
      () => at,
    );
    assert.deepEqual(
      metric(f.store.get("greenhouse_pull_candidate", candidate.id)?.reason),
      [{ metric: "duplicate" }],
    );
    assert.deepEqual(metric("Future screen wording that has no mapping"), [
      { metric: "otherScreen" },
    ]);
  } finally {
    await f.close();
  }
});

test("manager-produced unavailable, unlisted, technology and operational reasons stay classified", async () => {
  const f = fixture({
    posting: async (c) =>
      c.id === "1"
        ? null
        : c.id === "2"
          ? { ...posting(c), raw: { ...posting(c).raw, isListed: false } }
          : { ...posting(c), text: "Optional C# and ASP.NET experience." },
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      fitCriteria: normalizeFitCriteria({
        technologyExcludeTerms: ["C#", ".NET"],
      }),
    });
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.state()?.excluded === 3);
    const rows = f.manager.ledger(run.id).candidates;
    assert.deepEqual(
      rows.map((row) => metric(row.reason)),
      [
        [{ metric: "unavailable" }],
        [{ metric: "unavailable" }],
        [
          {
            metric: "technology",
            detail: pullTechnologyExclusion(f.store, card("3"), {
              ...posting(card("3")),
              text: "Optional C# and ASP.NET experience.",
            }),
          },
        ],
      ],
    );
  } finally {
    await f.close();
  }
  const failed = fixture({
    posting: async () => {
      throw new Error("Captured API read failed");
    },
  });
  try {
    const run = failed.manager.start();
    await failed.manager.tick();
    failed.manager.action(run.id, "stop");
    await advanceUntil(failed, () => failed.manager.state()?.deferred === 3);
    assert.ok(
      failed.manager
        .ledger(run.id)
        .candidates.every((row) => metric(row.reason)[0].metric === "workflow"),
    );
  } finally {
    await failed.close();
  }
});

const reviewExamples = {
  location:
    "This role is restricted to Germany; US-based employment is excluded.",
  onsite: "Hybrid role requires three days of office attendance each week.",
  travel:
    "Required travel to customer sites exceeds five percent of working time.",
  duties:
    "The exact duties are sales operations rather than software development.",
  seniority:
    "Director-level people management of multiple managers is mandatory.",
  expertise:
    "Required deep compiler expertise is not supported by the supplied evidence.",
  clearance: "An active security clearance and US citizenship are required.",
  compensation: "The published salary is below the stated acceptance floor.",
  engagement: "This is an internship limited to currently enrolled students.",
  closed: "The posting is closed and no longer accepting applications.",
  otherReview:
    "Material details remain unresolved in the official description.",
} as const;
for (const [expected, reason] of Object.entries(reviewExamples))
  test(`review grounds classify realistic ${expected} decisions`, () => {
    const result = classifyPullReview({
      reason,
      softwareAssessment: "This is software engineering work.",
      remoteAssessment: "Remote throughout the US.",
      fitAssessment: "Experience and salary align with the posting.",
    });
    assert.ok(
      result.some((item) => item.metric === expected),
      JSON.stringify(result),
    );
    if (expected === "otherReview")
      assert.deepEqual(result, [{ metric: "otherReview" }]);
  });
test("each skip counts once under its primary ground, and assessments only fill in for a reason that names none", () => {
  assert.deepEqual(
    classifyPullReview({
      reason:
        "Hybrid office attendance is mandatory, and the salary is below the minimum.",
      fitAssessment: "Required deep compiler expertise is missing.",
    }),
    [{ metric: "onsite" }],
  );
  // Location reasons usually also discuss eligibility; a named non-US place wins.
  assert.deepEqual(
    classifyPullReview({
      reason:
        "The job location is Remote - Canada, so it does not meet the US-compatible remote requirement and needs no clearance review.",
    }),
    [{ metric: "location" }],
  );
  // A published-pay sentence in an assessment is not a ground; an adverse one is used only as a fallback.
  assert.deepEqual(
    classifyPullReview({
      reason: "Material details remain unresolved in the official description.",
      fitAssessment:
        "Pay is published. Required deep compiler expertise is missing.",
    }),
    [{ metric: "expertise" }],
  );
});

test("travel decisions take precedence over broader location, onsite and expertise grounds", () => {
  for (const reason of [
    "Frequent travel to customer sites in Germany is required despite remote eligibility.",
    "Regular travel to customer sites requires onsite presence and is incompatible with the travel cap.",
    "Monthly multi-day client visits exceed the travel limit.",
    "A week per month traveling is required, beyond the five percent limit.",
    "Up to 25% travel is required despite otherwise compatible remote eligibility.",
    "Travel takes one week per month, incompatible with the remote requirement.",
  ])
    assert.deepEqual(
      classifyPullReview({ reason }),
      [{ metric: "travel" }],
      reason,
    );
  assert.deepEqual(
    classifyPullReview({
      reason:
        "Required deep travel industry expertise is not supported by the evidence.",
    }),
    [{ metric: "expertise" }],
  );
  for (const [reason, metric] of [
    [
      "Hybrid role requiring three days per week in the Austin office; travel is not required.",
      "onsite",
    ],
    [
      "US remote is not offered: candidates must live in the UK; no travel required.",
      "location",
    ],
  ] as const)
    assert.deepEqual(classifyPullReview({ reason }), [{ metric }], reason);
});

test("missing role-defining languages use the existing expertise ground before location wording", () => {
  for (const reason of [
    "The core programming language is absent from the resume despite US-compatible remote eligibility.",
    "Go Engineer has a missing core language requirement, despite otherwise eligible US remote work.",
    "Senior Rust Developer centers on Rust, a language missing from the supplied resume; the role is remote in the US.",
    "Day-to-day work is a Go-based build tool); Go is not among the languages on the supplied resume, despite US-compatible remote eligibility.",
  ])
    assert.deepEqual(
      classifyPullReview({ reason }),
      [{ metric: "expertise" }],
      reason,
    );
  assert.deepEqual(
    classifyPullReview({
      reason:
        "Hybrid office attendance is mandatory. The primary language is JavaScript; Rust is only a preferred language alongside it.",
    }),
    [{ metric: "onsite" }],
  );
});

test("the earlier publication-window wording still counts as the publication window", () => {
  assert.deepEqual(
    classifyPullScreen(
      "Original employer publication is outside the seven-day window. Updates do not reset freshness.",
    ),
    [{ metric: "publicationDate" }],
  );
});

test("explicit out-of-scope employment decisions have their own ground without changing contract context", () => {
  for (const reason of [
    "Employment type out of scope: this role is contract-only; Full time was selected.",
    "Employment-type outside the selected scope: only Full time is offered, but Contract is selected.",
    "Employment type out of scope: temporary part-time arrangement only.",
  ])
    assert.deepEqual(
      classifyPullReview({ reason }),
      [{ metric: "employmentType" }],
      reason,
    );
  for (const [reason, expected] of [
    ["This contract role is Canada-only.", "location"],
    ["Contract compensation is below the stated range.", "compensation"],
    ["Contract role requires hybrid office attendance.", "onsite"],
    ["Temporary contract duration is only two weeks.", "engagement"],
    ["Requires deep contract-law domain expertise.", "expertise"],
  ])
    assert.deepEqual(
      classifyPullReview({ reason }),
      [{ metric: expected }],
      reason,
    );
});
