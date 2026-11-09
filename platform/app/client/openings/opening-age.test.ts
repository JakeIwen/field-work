import test from "node:test";
import assert from "node:assert/strict";

await import("../testing/test-render.js");
const { emptyOpeningAge, matchesOpeningAge } =
  await import("./OpeningAgeFilter.js");
const { opening } = await import("../testing/component-fixtures.js");

test("opening age uses the selected date, strict boundaries, and excludes unknown dates", () => {
  const now = new Date(2026, 9, 13, 12);
  const filter = {
    ...emptyOpeningAge,
    ageDate: "published",
    ageComparison: "older",
    ageDays: "7",
  };
  const role = {
    ...opening,
    first_published: "2026-10-05",
    createdAt: "2026-10-12",
  };
  assert.equal(matchesOpeningAge(role, filter, now), true);
  assert.equal(
    matchesOpeningAge(role, { ...filter, ageDate: "added" }, now),
    false,
  );
  assert.equal(
    matchesOpeningAge({ ...role, first_published: "2026-10-06" }, filter, now),
    false,
  );
  assert.equal(
    matchesOpeningAge(
      { ...role, first_published: "2026-10-06" },
      { ...filter, ageComparison: "newer" },
      now,
    ),
    false,
  );
  assert.equal(
    matchesOpeningAge(
      role,
      { ...filter, ageComparison: "newer", ageDate: "added" },
      now,
    ),
    true,
  );
  assert.equal(
    matchesOpeningAge({ ...role, first_published: undefined }, filter, now),
    false,
  );
  assert.equal(
    matchesOpeningAge({ ...role, first_published: "invalid" }, filter, now),
    false,
  );
  assert.equal(matchesOpeningAge(role, emptyOpeningAge, now), true);
  assert.equal(matchesOpeningAge(role, { ...filter, ageDays: "" }, now), true);
  assert.equal(
    matchesOpeningAge(role, { ...filter, ageDays: "-1" }, now),
    true,
  );
});

test("opening age preserves calendar dates and handles local timestamp days across DST", () => {
  const original = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    const filter = { ...emptyOpeningAge, ageComparison: "older", ageDays: "1" };
    const now = new Date("2026-11-02T07:00:00Z");
    assert.equal(
      matchesOpeningAge(
        { ...opening, createdAt: "2026-11-01T03:00:00Z" },
        filter,
        now,
      ),
      true,
    );
    assert.equal(
      matchesOpeningAge({ ...opening, createdAt: "2026-11-01" }, filter, now),
      false,
    );
    assert.equal(
      matchesOpeningAge({ ...opening, first_seen: "2026-10-31" }, filter, now),
      true,
    );
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
