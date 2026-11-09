import test from "node:test";
import assert from "node:assert/strict";
import { formatDate, calendarDate } from "./dates.js";

test("timestamp display stays in America/Denver time across machine timezone changes while date-only values stay literal", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/Denver";
    assert.equal(
      formatDate("2026-10-07T05:30:00Z", true),
      "Oct 6, 2026, 11:30 PM",
    );
    assert.equal(formatDate("2026-10-07"), "Oct 7, 2026");
    process.env.TZ = "Asia/Tokyo";
    assert.equal(
      formatDate("2026-10-07T05:30:00Z", true),
      "Oct 6, 2026, 11:30 PM",
    );
    assert.equal(formatDate("2026-10-07"), "Oct 7, 2026");
    assert.equal(formatDate(null), "Unknown");
    assert.equal(formatDate("unverified date"), "unverified date");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("explicit workflow calendar calculations retain their configured timezone", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/Denver";
    const at = new Date("2026-10-07T05:30:00Z");
    assert.equal(calendarDate("America/Chicago", at), "2026-10-07");
    assert.equal(calendarDate("America/Denver", at), "2026-10-06");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("Sunday just after Central midnight is still Saturday in America/Denver", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/Chicago";
    assert.equal(
      formatDate("2026-10-18T05:54:54.170Z", true),
      "Oct 17, 2026, 11:54 PM",
    );
    assert.equal(formatDate("2026-10-18T05:55:09.836Z"), "Oct 17, 2026");
    assert.equal(formatDate("2026-10-18T06:00:00Z"), "Oct 18, 2026");
    assert.equal(
      calendarDate(undefined, new Date("2026-10-18T05:55:00Z")),
      "2026-10-17",
    );
    assert.equal(
      formatDate("2026-01-18T06:55:00Z", true),
      "Jan 17, 2026, 11:55 PM",
    );
    assert.equal(
      formatDate("2026-03-08T08:59:00Z", true),
      "Mar 8, 2026, 1:59 AM",
    );
    assert.equal(
      formatDate("2026-03-08T09:00:00Z", true),
      "Mar 8, 2026, 3:00 AM",
    );
    assert.equal(
      formatDate("2026-11-01T07:30:00Z", true),
      "Nov 1, 2026, 1:30 AM",
    );
    assert.equal(
      formatDate("2026-11-01T08:30:00Z", true),
      "Nov 1, 2026, 1:30 AM",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
