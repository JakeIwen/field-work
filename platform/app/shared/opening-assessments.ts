export const openingAssessmentValues = [
  "High",
  "Medium",
  "Low",
  "Uncertain",
  "Unknown",
] as const;
export type OpeningAssessmentValue = (typeof openingAssessmentValues)[number];
export type OpeningAssessmentDetails = {
  technicalFit: string;
  remoteFit: string;
  wlbOutlook: string;
};

type Source = {
  technical_fit?: unknown;
  remote_fit?: unknown;
  wlb_outlook?: unknown;
  assessmentDetails?: unknown;
  assessmentSourceHash?: unknown;
  hash?: unknown;
};

export function isOpeningAssessmentValue(
  value: unknown,
): value is OpeningAssessmentValue {
  return openingAssessmentValues.some((option) => option === value);
}

/** Only carry forward an explicit rating, never infer one from descriptive prose. */
export function normalizeOpeningAssessment(
  value: unknown,
): OpeningAssessmentValue {
  if (typeof value !== "string") return "Unknown";
  const label = value
    .trim()
    .match(
      /^(High|Medium|Low|Uncertain|Unknown)(?:\s*$|\s*[:;,]|\.(?=\s|$)|\s+[\u2013\u2014-](?=\s|$))/i,
    )?.[1];
  return (
    openingAssessmentValues.find(
      (option) => option.toLowerCase() === label?.toLowerCase(),
    ) ?? "Unknown"
  );
}

export function validOpeningAssessmentDetails(
  value: unknown,
): value is OpeningAssessmentDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["technicalFit", "remoteFit", "wlbOutlook"].every((key) => {
    const detail = (value as Record<string, unknown>)[key];
    return (
      typeof detail === "string" && !!detail.trim() && detail.length <= 8000
    );
  });
}

export function openingAssessmentDetails(
  opening: Source,
): OpeningAssessmentDetails {
  if (
    validOpeningAssessmentDetails(opening.assessmentDetails) &&
    (!opening.assessmentSourceHash ||
      opening.assessmentSourceHash === opening.hash)
  ) {
    return opening.assessmentDetails;
  }
  // On source refresh, only the current authoritative fields may supply a fallback.
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    technicalFit: text(opening.technical_fit),
    remoteFit: text(opening.remote_fit),
    wlbOutlook: text(opening.wlb_outlook),
  };
}

export function openingAssessmentValuesFor(
  opening: Source,
): Record<keyof OpeningAssessmentDetails, OpeningAssessmentValue> {
  return {
    technicalFit: normalizeOpeningAssessment(opening.technical_fit),
    remoteFit: normalizeOpeningAssessment(opening.remote_fit),
    wlbOutlook: normalizeOpeningAssessment(opening.wlb_outlook),
  };
}

/** Dates must be explicit calendar dates or ISO timestamps with a timezone. */
export function validOpeningDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const date = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/,
  );
  if (!date) return false;
  const year = Number(date[1]),
    month = Number(date[2]),
    day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    Number.isFinite(Date.parse(value))
  );
}
