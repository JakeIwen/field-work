import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { defaultGreenhousePullPolicy } from "../shared/greenhouse-policy.js";
import { greenhouseReviewInstructionsFor } from "../server/greenhouse-research.js";
import { greenhouseReviewPrompt } from "../server/opening-pull/review-prompt.js";
import { draftPath } from "../server/bundles.js";
import { memoryFixture } from "./fixtures/greenhouse-memory.js";
import {
  at,
  fixture,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";

const hour = 60 * 60 * 1000;

test("travel caps generate appropriate examples and annual days; disabled rules leave no exclusion instruction", () => {
  const instructions = (
    travelCapPercent: number | null,
    excludeMissingLanguage = true,
  ) =>
    greenhouseReviewInstructionsFor({
      ...defaultGreenhousePullPolicy,
      travelCapPercent,
      excludeMissingLanguage,
    });
  assert.match(instructions(5), /above 5%.*11–12 working days/);
  assert.match(
    instructions(5),
    /a week per month, monthly multi-day client visits, frequent travel or regular travel/,
  );
  assert.match(instructions(20), /above 20%.*44–48 working days/);
  assert.match(instructions(20), /a week per month/);
  assert.doesNotMatch(
    instructions(20),
    /monthly multi-day client visits|frequent travel/,
  );
  assert.match(instructions(50), /above 50%.*110–120 working days/);
  assert.doesNotMatch(
    instructions(50),
    /a week per month|monthly multi-day|frequent travel/,
  );
  assert.match(instructions(0), /above 0%.*0 working days/);
  assert.match(instructions(0), /do not assume they are exempt/);
  assert.doesNotMatch(
    instructions(null),
    /exclude required travel|working days a year|heavier non-percentage/,
  );
  assert.match(instructions(null), /programming language absent/);
  assert.doesNotMatch(
    instructions(null, false),
    /programming language absent|core-language exception|Go Engineer/,
  );
  assert.match(
    instructions(null, false),
    /Do not silently discard Staff\/Lead roles/,
  );
});

test("preview equals a new run's actual captured review and research files under custom policy", async () => {
  const f = memoryFixture();
  try {
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        freshnessDays: 10,
        travelCapPercent: null,
        excludeMissingLanguage: false,
        titleTriage: false,
        reuseReviews: false,
        deferralReuseHours: 12,
        regularSearchTerms: ["web"],
      },
      greenhouseGuidance: {
        instructions: "Check usable vacation.",
        searchTerms: [],
        employmentScope: ["contract"],
      },
      greenhouseExcludedCompanies: ["Other"],
      fitCriteria: {
        ...old.fitCriteria,
        titleExcludeTerms: ["Mobile"],
        technologyExcludeTerms: ["COBOL"],
      },
    });
    const preview = greenhouseReviewPrompt(f.store);
    const run = f.manager.start(10, "preview");
    const task = await f.running();
    for (const file of [
      "HARVEST-INSTRUCTIONS.md",
      "RESEARCH-INSTRUCTIONS.md",
    ]) {
      const section = preview.sections.find((section) =>
        section.title.endsWith(file),
      );
      assert.equal(
        section?.text,
        readFileSync(draftPath(f.store, task.id, file), "utf8"),
      );
    }
    const screening =
      preview.sections.find((section) =>
        section.title.startsWith("Other selection"),
      )?.text ?? "";
    for (const pattern of [
      /within 10 days/,
      /11 days total/,
      /Travel exclusion is disabled/,
      /not an automatic exclusion/,
      /title screening is disabled/,
      /Review reuse is disabled/,
      /12 hours/,
      /Regular search terms: web/,
      /COBOL/,
      /Mobile/,
      /Other/,
      /combined with the live list/,
    ])
      assert.match(screening, pattern);
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        travelCapPercent: 80,
      },
    });
    assert.deepEqual(f.manager.state()?.policy, run.policy);
    assert.match(
      greenhouseReviewPrompt(f.store).sections.find((section) =>
        section.title.endsWith("HARVEST-INSTRUCTIONS.md"),
      )?.text ?? "",
      /above 80%/,
    );
    assert.doesNotMatch(
      readFileSync(
        draftPath(f.store, task.id, "HARVEST-INSTRUCTIONS.md"),
        "utf8",
      ),
      /above 80%/,
    );
  } finally {
    await f.close();
  }
});

for (const policy of [
  { travelCapPercent: 10 },
  { travelCapPercent: null },
  { excludeMissingLanguage: false },
  { reuseReviews: false },
])
  test(`changed decision policy ${JSON.stringify(policy)} prevents reuse`, async () => {
    const f = memoryFixture();
    try {
      f.manager.start(10, "first");
      await f.running();
      await f.finish();
      await f.exhaust();
      f.store.put("settings", "main", {
        ...f.store.settings(),
        greenhousePolicy: { ...defaultGreenhousePullPolicy, ...policy },
      });
      f.manager.start(10, "second");
      await f.running();
      assert.equal(f.store.list("task").length, 2);
      assert.equal(f.manager.state()?.remembered, 0);
    } finally {
      await f.close();
    }
  });

for (const deferralReuseHours of [1, 10])
  test(`deferrals use the captured ${deferralReuseHours}-hour reuse lifetime`, async () => {
    const f = memoryFixture();
    try {
      f.manager.start(10, "first");
      await f.running();
      await f.finish("deferred");
      await f.exhaust();
      f.store.put("settings", "main", {
        ...f.store.settings(),
        greenhousePolicy: {
          ...defaultGreenhousePullPolicy,
          deferralReuseHours,
        },
      });
      f.controls.setTime(at + 2 * hour);
      f.manager.start(10, "second");
      // A later settings change must not shorten/extend this run’s lifetime.
      f.store.put("settings", "main", {
        ...f.store.settings(),
        greenhousePolicy: {
          ...defaultGreenhousePullPolicy,
          deferralReuseHours: deferralReuseHours === 1 ? 10 : 1,
        },
      });
      if (deferralReuseHours === 1) {
        await f.running();
        assert.equal(f.store.list("task").length, 2);
      } else {
        await f.exhaust();
        assert.equal(f.manager.state()?.remembered, 1);
        assert.equal(f.store.list("task").length, 1);
      }
    } finally {
      await f.close();
    }
  });

test("memory fingerprints retain captured decision inputs despite live edits; freshness and query changes are separate", async () => {
  const f = memoryFixture();
  try {
    f.manager.start(10, "first");
    await f.running();
    await f.finish();
    await f.exhaust();
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        freshnessDays: 10,
        regularSearchTerms: ["web"],
        titleTriage: false,
      },
    });
    f.manager.start(10, "second");
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        travelCapPercent: null,
        excludeMissingLanguage: false,
        reuseReviews: false,
      },
      fitCriteria: { ...old.fitCriteria, technologyExcludeTerms: ["React"] },
      greenhouseGuidance: {
        instructions: "Different guidance.",
        searchTerms: [],
        employmentScope: ["contract"],
      },
    });
    await f.exhaust();
    assert.equal(f.manager.state()?.remembered, 1);
    assert.equal(f.store.list("task").length, 1);
  } finally {
    await f.close();
  }
});

test("legacy runs retain default review rules and reuse when today's saved policy is different", async () => {
  const f = memoryFixture();
  try {
    const first = f.manager.start(10, "first");
    f.store.put("greenhouse_pull_run", first.id, {
      ...first,
      policy: undefined,
    });
    await f.running();
    await f.finish();
    await f.exhaust();
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        travelCapPercent: null,
        excludeMissingLanguage: false,
        reuseReviews: false,
        deferralReuseHours: 1,
      },
    });
    const second = f.manager.start(10, "second");
    f.store.put("greenhouse_pull_run", second.id, {
      ...second,
      policy: undefined,
    });
    await f.exhaust();
    assert.equal(f.manager.state()?.remembered, 1);
    assert.equal(f.manager.state()?.policy?.legacy, true);
    assert.equal(f.store.list("task").length, 1);
  } finally {
    await f.close();
  }
});

test("publication honors captured technology exclusions after settings change", async () => {
  const f = fixture();
  try {
    f.manager.start(1, "publication");
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      fitCriteria: { ...old.fitCriteria, technologyExcludeTerms: ["React"] },
    });
    f.finish();
    await advanceUntil(f, () => f.manager.state()?.added === 1);
    assert.equal(f.store.openings().length, 1);
  } finally {
    await f.close();
  }
});
