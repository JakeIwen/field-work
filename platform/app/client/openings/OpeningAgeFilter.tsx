import { FIELDWORK_TIMEZONE } from "../../shared/timezone";
import type { Opening } from "../../shared/types";
import { calendarDate } from "../ui/dates";
import InfoTooltip from "../ui/InfoTooltip";
import { openingAddedDate, openingPostedDate } from "./opening-sort";

export const emptyOpeningAge = { ageDate: "added", ageComparison: "", ageDays: "7" };
type AgeFilter = typeof emptyOpeningAge;

export function matchesOpeningAge(opening: Opening, filter: AgeFilter, now = new Date()) {
  if (!filter.ageComparison || !filter.ageDays.trim()) return true;
  const days = Number(filter.ageDays);
  if (!Number.isInteger(days) || days < 0) return true;
  const value = filter.ageDate === "published" ? openingPostedDate(opening) : openingAddedDate(opening).value;
  if (!value) return false;
  // Match the calendar days displayed in Fieldwork, preserving date-only values.
  const zone = FIELDWORK_TIMEZONE;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : calendarDate(zone, new Date(value));
  const age = (Date.parse(calendarDate(zone, now)) - Date.parse(date)) / 86400000;
  return filter.ageComparison === "older" ? age > days : age < days;
}

export default function OpeningAgeFilter({ filters, set }: {
  filters: AgeFilter;
  set: (key: keyof AgeFilter, value: string) => void;
}) {
  return <div className="opening-age-filter" role="group" aria-label="Opening age">
    <label>Date<select aria-label="Age date" value={filters.ageDate} onChange={e => set("ageDate", e.target.value)}>
      <option value="added">Added</option><option value="published">Published</option>
    </select></label>
    <div className="opening-age-control">
      <span className="opening-age-label"><label htmlFor="opening-age-comparison">Age</label><InfoTooltip label="About opening age">Calendar days; openings with unknown dates are excluded.</InfoTooltip></span>
      <select id="opening-age-comparison" aria-label="Opening age" value={filters.ageComparison} onChange={e => set("ageComparison", e.target.value)}>
        <option value="">Any age</option><option value="older">Older than</option><option value="newer">Newer than</option>
      </select>
    </div>
    {filters.ageComparison && <>
      <label>Days<input aria-label="Age in days" type="number" min="0" step="1" value={filters.ageDays} onChange={e => set("ageDays", e.target.value)} /></label>
    </>}
  </div>;
}
