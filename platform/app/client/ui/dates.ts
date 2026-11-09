import { FIELDWORK_TIMEZONE } from "../../shared/timezone";

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
/** Display real timestamps in America/Denver time; calendar-only values stay dates. */
export function formatDate(
  value?: string | null,
  time: boolean | "seconds" = false,
) {
  if (!value) return "Unknown";
  if (dateOnly.test(value)) {
    const [y, m, d] = value.split("-");
    return `${new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(`${y}-${m}-${d}T12:00:00Z`))} ${Number(d)}, ${y}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeZone: FIELDWORK_TIMEZONE,
      ...(time ? { timeStyle: time === "seconds" ? "long" : "short" } : {}),
      ...(time === "seconds" ? { hour12: false } : {}),
    }).format(date);
  } catch {
    return value;
  }
}

/** Calendar date (YYYY-MM-DD) of `at` in an IANA timezone. */
export function calendarDate(timezone = FIELDWORK_TIMEZONE, at: Date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
/** Add whole days to a YYYY-MM-DD calendar date without timezone drift. */
export function addCalendarDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Leading YYYY-MM-DD of a date or timestamp string, or "" when absent/invalid. */
export const dayOf = (value?: string | null) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
