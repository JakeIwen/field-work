import test from "node:test";
import assert from "node:assert/strict";
import { appliedOpeningIds } from "../shared/opening-applications.js";

test("submitted openings remain applied through later stages", () => {
  // Preserve the existing fixture statuses as literals rather than widening them to string.
  const applications = (
    ["applied", "interviewing", "offer", "rejected", "withdrawn"] as const
  ).map((status) => ({
    openingId: status,
    status,
    submittedAt: "2026-09-20T12:00:00Z",
  }));
  const before = JSON.stringify(applications);
  assert.deepEqual(
    [...appliedOpeningIds(applications)],
    applications.map((a) => a.openingId),
  );
  assert.equal(JSON.stringify(applications), before);
});

test("starting or preparing documents does not mean applied; legacy applied stages still count", () => {
  // Preserve the existing fixture statuses as literals rather than widening them to string.
  const applications = (
    [
      "considering",
      "preparing",
      "ready",
      "rejected",
      "withdrawn",
      "applied",
      "interviewing",
      "offer",
    ] as const
  ).map((status) => ({
    openingId: status,
    status,
    applicationDate: "2026-09-20",
  }));
  assert.deepEqual(
    [...appliedOpeningIds(applications)],
    ["applied", "interviewing", "offer"],
  );
  assert.deepEqual(
    [
      ...appliedOpeningIds([
        { openingId: "same", status: "applied" },
        { openingId: "same", status: "preparing" },
      ]),
    ],
    ["same"],
  );
});
