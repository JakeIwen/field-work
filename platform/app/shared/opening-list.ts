/** Display-only summaries. Full research fields remain authoritative. */
import { normalizeOpeningAssessment } from "./opening-assessments";
export const openingListLimits = {
  location: 60,
  technicalFit: 48,
  wlbOutlook: 48,
  compensation: 80,
} as const;
export type OpeningListSummary = Record<keyof typeof openingListLimits, string>;
type Source = {
  location?: unknown;
  technical_fit?: unknown;
  wlb_outlook?: unknown;
  compensation?: unknown;
  listSummary?: unknown;
  listSummarySourceHash?: unknown;
  hash?: unknown;
};
const plain = (v: unknown) =>
  typeof v === "string"
    ? v
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
export function validOpeningListSummary(
  value: unknown,
): value is OpeningListSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(openingListLimits).every(([key, max]) => {
    const text = (value as Record<string, unknown>)[key];
    return (
      typeof text === "string" &&
      !!text.trim() &&
      text.length <= max &&
      !/[\r\n*`]|__|\[[^\]]+\]\([^)]*\)|^#{1,6}\s/.test(text)
    );
  });
}
function locationSummary(value: unknown) {
  const text = plain(value);
  if (!text || /^unknown$/i.test(text)) return "Location unknown";
  if (text.length <= 60) return text;
  const first = text.split(/;|\.\s/)[0];
  return first.length <= 60 ? first : "See location restrictions";
}
function fitSummary(value: unknown) {
  return normalizeOpeningAssessment(value);
}
function wlbSummary(value: unknown) {
  return normalizeOpeningAssessment(value);
}
export function compensationSummary(value: unknown) {
  const text = plain(value);
  if (
    !text ||
    /^(unknown|not published|not disclosed|not specified)$/i.test(text)
  )
    return "Not published";
  if (text.length <= 80) return text;
  if (
    /(?:salary|pay|base)[^.]{0,35}(?:not disclosed|not published|not specified|unknown)/i.test(
      text,
    )
  )
    return "Base pay not published";
  if (/historical|previous posting|expired|estimate/i.test(text))
    return "Historical / estimated pay";
  const currencies = [
    ...new Set(text.match(/\b(?:USD|CAD|AUD|EUR|GBP)\b/g) || []),
  ];
  const currency = currencies.length === 1 ? currencies[0] + " · " : "";
  const money = "[$€£]\\s*\\d[\\d,]*(?:\\.\\d+)?[kK]?";
  const hourly = text.match(
    new RegExp("(" + money + ")\\s*(?:/|per\\s+)(?:hour|hr)\\b", "i"),
  );
  if (hourly) {
    const cap = text.match(/up to\s+(\d+)\s*hours?/i);
    return `${currency}${hourly[1]}/hr${cap ? ` · up to ${cap[1]}h/week` : ""}`;
  }
  const range = new RegExp(
    money + "\\s*[–—-]\\s*[$€£]?\\s*\\d[\\d,]*(?:\\.\\d+)?[kK]?",
    "g",
  );
  const ranges = [...text.matchAll(range)];
  if (
    /geograph|structure \d|zone [a-z]|location.based|depend.{0,25}location|var(?:y|ies).{0,25}location/i.test(
      text,
    )
  )
    return `${currency}Location-based pay bands`;
  if (ranges.length > 1) return `${currency}Multiple pay ranges · see details`;
  if (ranges.length === 1)
    return `${currency}${ranges[0][0]}${/\bbase\b/i.test(text) ? " base" : ""}`;
  return "See compensation details";
}
export function openingListSummary(opening: Source): OpeningListSummary {
  if (
    validOpeningListSummary(opening.listSummary) &&
    (!opening.listSummarySourceHash ||
      opening.listSummarySourceHash === opening.hash)
  )
    return opening.listSummary;
  const compensation = compensationSummary(opening.compensation);
  return {
    location: locationSummary(opening.location),
    technicalFit: fitSummary(opening.technical_fit),
    wlbOutlook: wlbSummary(opening.wlb_outlook),
    compensation:
      compensation.length <= 80 ? compensation : "See compensation details",
  };
}
