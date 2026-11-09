import test from "node:test";
import assert from "node:assert/strict";
import {
  openingAssessmentValues,
  isOpeningAssessmentValue,
  normalizeOpeningAssessment,
  validOpeningAssessmentDetails,
  openingAssessmentDetails,
  openingAssessmentValuesFor,
  validOpeningDate,
} from "../shared/opening-assessments.js";

test("assessment categories require explicit labels and distinguish missing from unresolved evidence", () => {
  for (const value of openingAssessmentValues) {
    assert.ok(isOpeningAssessmentValue(value));
    assert.equal(normalizeOpeningAssessment(value.toLowerCase()), value);
  }
  assert.equal(isOpeningAssessmentValue("high"), false);
  assert.equal(
    normalizeOpeningAssessment(
      " High: React and Node match; Go would be new. ",
    ),
    "High",
  );
  assert.equal(
    normalizeOpeningAssessment("medium — adjacent production experience"),
    "Medium",
  );
  assert.equal(
    normalizeOpeningAssessment(
      "Uncertain; researched but workload remains unresolved",
    ),
    "Uncertain",
  );
  for (const value of [
    undefined,
    null,
    {},
    "",
    "Excellent React match",
    "High workload expected",
    "Highly relevant",
    "Medium-sized company",
    "Unknowns remain",
  ]) {
    assert.equal(normalizeOpeningAssessment(value), "Unknown", String(value));
  }
  assert.deepEqual(
    openingAssessmentValuesFor({
      technical_fit: "High: React overlap",
      remote_fit: "US remote; state rules unresolved",
      wlb_outlook: "Uncertain",
    }),
    {
      technicalFit: "High",
      remoteFit: "Unknown",
      wlbOutlook: "Uncertain",
    },
  );
});

test("full assessment prose survives categorization without reusing stale detail after a source refresh", () => {
  const legacy = {
    technical_fit:
      "High: React, Node.js and production modernization match. Specialized streaming work is new.",
    remote_fit:
      "US remote; employer approval for work while traveling has not been established.",
    wlb_outlook:
      "Uncertain: the employer promises flexible hours; actual on-call frequency is unknown.",
  };
  const before = JSON.stringify(legacy);
  const details = openingAssessmentDetails(legacy);
  assert.deepEqual(details, {
    technicalFit: legacy.technical_fit,
    remoteFit: legacy.remote_fit,
    wlbOutlook: legacy.wlb_outlook,
  });
  assert.equal(JSON.stringify(legacy), before);
  assert.ok(validOpeningAssessmentDetails(details));
  assert.equal(
    validOpeningAssessmentDetails({ ...details, technicalFit: " " }),
    false,
  );
  assert.equal(
    validOpeningAssessmentDetails({ ...details, remoteFit: "x".repeat(8001) }),
    false,
  );
  assert.equal(validOpeningAssessmentDetails([details]), false);
  assert.deepEqual(
    openingAssessmentDetails({
      ...legacy,
      assessmentDetails: details,
      assessmentSourceHash: "same",
      hash: "same",
    }),
    details,
  );
  const refreshed = openingAssessmentDetails({
    technical_fit: "Medium",
    remote_fit: "Low",
    wlb_outlook: "Unknown",
    assessmentDetails: details,
    assessmentSourceHash: "old",
    hash: "new",
  });
  assert.deepEqual(refreshed, {
    technicalFit: "Medium",
    remoteFit: "Low",
    wlbOutlook: "Unknown",
  });
  assert.equal(refreshed.technicalFit.includes("streaming"), false);
});

test("opening dates reject calendar rollovers and ambiguous or timezone-free timestamps", () => {
  for (const value of [
    null,
    "2026-09-20",
    "2024-02-29",
    "2000-02-29",
    "2026-09-20T12:34Z",
    "2026-09-20T12:34:56.123Z",
    "2026-09-20T00:00:00-05:00",
    "2026-09-20T23:59:59+14:00",
  ]) {
    assert.ok(validOpeningDate(value), String(value));
  }
  for (const value of [
    undefined,
    "",
    "Unknown",
    "September 20, 2026",
    "2026-9-20",
    "2026-09-20 ",
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-00-20",
    "2026-13-01",
    "2026-09-00",
    "2026-09-20T12:34:56",
    "2026-09-20 12:34:56Z",
    "2026-09-20T24:00:00Z",
    "2026-09-20T12:60:00Z",
    "2026-09-20T12:34:60Z",
    "2026-09-20T12:34:56+24:00",
    "2026-09-20T12:34:56+05:60",
  ]) {
    assert.equal(validOpeningDate(value), false, String(value));
  }
});
