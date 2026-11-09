import test from "node:test";
import assert from "node:assert/strict";
import {
  openingListSummary,
  validOpeningListSummary,
  openingListLimits,
} from "../../shared/opening-list.js";
import { sortApplications } from "./application-sort.js";
import type { Application, Opening } from "../../shared/types.js";
test("terse fallback preserves compensation caveats and never invents a fit rating", () => {
  const full = {
    location:
      "United States (remote). The employer requires an approved work state and substantial additional location details.",
    technical_fit:
      "Assessment: strong overlap in consulting and full-stack production engineering, with a partial match to leadership requirements.",
    wlb_outlook:
      "Employer claims flexible hours, but actual on-call frequency and workload have not been established.",
    compensation:
      "Published annual salary ranges in USD depend on geographic structure: Structure 1 $126,279–$157,849; Structure 2 $147,000–$180,000.",
  };
  const original = JSON.stringify(full),
    s = openingListSummary(full);
  assert.equal(s.location, "United States (remote)");
  assert.equal(s.technicalFit, "Unknown");
  assert.match(s.compensation, /Location-based pay bands/);
  assert.doesNotMatch(s.compensation, /180,000/);
  assert.equal(JSON.stringify(full), original);
  for (const [key, max] of Object.entries(openingListLimits))
    assert.ok(s[key as keyof typeof s].length <= max);
  const hourly = openingListSummary({
    compensation:
      "USD $150/hour, up to 25 hours/week; part-time, non-exempt, no benefits. Maximum stated weekly gross is $3,750, but guaranteed hours and paid time off are not specified.",
  });
  assert.equal(hourly.compensation, "USD · $150/hr · up to 25h/week");
  const historical = openingListSummary({
    compensation:
      "Historical USD salary bands differed by geographic location: $140,000–$180,000 for one area and $150,000–$200,000 for another.",
  });
  assert.equal(historical.compensation, "Historical / estimated pay");
});
test("generated list summaries are bounded and invalidated by a newer full-source hash", () => {
  const summary = {
    location: "US remote · location rules",
    technicalFit: "React/Node; Django gap",
    wlbOutlook: "On-call frequency unknown",
    compensation: "USD · geographic pay bands",
  };
  assert.ok(validOpeningListSummary(summary));
  assert.equal(
    validOpeningListSummary({ ...summary, technicalFit: "x".repeat(49) }),
    false,
  );
  assert.equal(
    validOpeningListSummary({ ...summary, location: "US\nRemote" }),
    false,
  );
  assert.equal(
    validOpeningListSummary({ ...summary, technicalFit: "**High**" }),
    false,
  );
  assert.deepEqual(
    openingListSummary({
      listSummary: summary,
      hash: "a",
      listSummarySourceHash: "a",
    }),
    summary,
  );
  assert.notDeepEqual(
    openingListSummary({
      listSummary: summary,
      hash: "new",
      listSummarySourceHash: "a",
      compensation: "Not published",
    }),
    summary,
  );
});
test("application sorting handles stages, linked roles and unknown dates without changing records", () => {
  const apps = [
    {
      id: "a",
      openingId: "one",
      status: "preparing",
      createdAt: "2026-09-10T12:00:00Z",
      applicationDate: "2026-09-09",
      followUp: "",
    },
    {
      id: "b",
      openingId: "two",
      status: "considering",
      createdAt: "2026-09-20T12:00:00Z",
      followUp: "2026-09-22",
    },
    {
      id: "c",
      openingId: "missing",
      status: "applied",
      createdAt: "2026-09-15T12:00:00Z",
      submittedAt: "2026-09-16T12:00:00Z",
      followUp: "2026-09-21",
    },
  ] as Application[];
  const roles = [
    { id: "one", company: "Zulu", title: "Engineer" },
    { id: "two", company: "Alpha", title: "Developer" },
  ] as Opening[];
  const stages = ["considering", "preparing", "applied"];
  const sorted = (mode: string) =>
    sortApplications(apps, roles, mode, stages).map((a) => a.id);
  assert.deepEqual(sorted("newest"), ["b", "c", "a"]);
  assert.deepEqual(sorted("oldest"), ["a", "c", "b"]);
  assert.deepEqual(sorted("company"), ["b", "a", "c"]);
  assert.deepEqual(sorted("stage"), ["b", "a", "c"]);
  assert.deepEqual(sorted("followup"), ["c", "b", "a"]);
  assert.deepEqual(sorted("followup-desc"), ["b", "c", "a"]);
  assert.deepEqual(sorted("stage-desc"), ["c", "a", "b"]);
  assert.deepEqual(
    sortApplications(
      apps,
      roles,
      "next-action",
      stages,
      (a) => ({ a: "Write", b: "Apply", c: "" })[a.id],
    ).map((a) => a.id),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    sortApplications(
      apps,
      roles,
      "next-action-desc",
      stages,
      (a) => ({ a: "Write", b: "Apply", c: "" })[a.id],
    ).map((a) => a.id),
    ["a", "b", "c"],
  );
  assert.equal(sorted("submitted")[0], "c");
  assert.equal(sorted("application-date")[0], "a");
  assert.deepEqual(
    apps.map((a) => a.id),
    ["a", "b", "c"],
  );
  assert.equal(apps[0].submittedAt, undefined);
});

test("applications default to latest submission, with missing dates last in either direction", () => {
  const apps = [
    {
      id: "unsent",
      openingId: "one",
      createdAt: "2026-10-19T12:00:00Z",
      applicationDate: "2026-10-19",
    },
    { id: "older", openingId: "two", submittedAt: "2026-10-17T12:00:00Z" },
    { id: "recent", openingId: "three", submittedAt: "2026-10-18T12:00:00Z" },
  ] as Application[];
  for (const mode of [null, "invalid", "submitted"]) {
    assert.deepEqual(
      sortApplications(apps, [], mode, []).map((a) => a.id),
      ["recent", "older", "unsent"],
    );
  }
  assert.deepEqual(
    sortApplications(apps, [], "submitted-asc", []).map((a) => a.id),
    ["older", "recent", "unsent"],
  );
});
