import { educationSchoolKey } from "./resume-facts.js";

export type ConfirmedEducation = {
  school: string;
  degree?: string | null;
  discipline?: string | null;
  startMonth?: string | null;
  startYear?: string | null;
  endMonth?: string | null;
  endYear?: string | null;
};

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function confirmedEducation(value: unknown): ConfirmedEducation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.school !== "string" ||
    !input.school.trim() ||
    input.school.length > 300
  )
    return null;
  const result: ConfirmedEducation = { school: input.school.trim() };
  for (const key of [
    "degree",
    "discipline",
    "startMonth",
    "startYear",
    "endMonth",
    "endYear",
  ] as const) {
    const raw = input[key];
    if (raw === undefined) continue;
    if (raw === null) {
      result[key] = null;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim() || raw.length > 300) return null;
    const text = raw.trim();
    if (key.endsWith("Month") && !months.includes(text)) return null;
    if (key.endsWith("Year") && !/^(?:19|20|21)\d{2}$/.test(text)) return null;
    result[key] = text;
  }
  if (result.startYear && result.endYear) {
    const start =
      Number(result.startYear) * 12 +
      (result.startMonth ? months.indexOf(result.startMonth) : 0);
    const end =
      Number(result.endYear) * 12 +
      (result.endMonth ? months.indexOf(result.endMonth) : 11);
    if (start > end) return null;
  }
  return result;
}

type EducationProfile = {
  school?: unknown;
  education?: unknown;
  resumeFacts?: {
    education?: Pick<
      ConfirmedEducation,
      "degree" | "discipline" | "endYear"
    > | null;
  } | null;
};

export function primaryEducation(profile: EducationProfile) {
  const confirmed = confirmedEducation(profile.education);
  if (!confirmed) return profile.resumeFacts?.education ?? null;
  // Dates and degree belong to this school, never to a different campus/entry.
  if (
    typeof profile.school === "string" &&
    educationSchoolKey(profile.school) !== educationSchoolKey(confirmed.school)
  )
    return profile.resumeFacts?.education ?? null;
  return { ...profile.resumeFacts?.education, ...confirmed };
}

export function educationDateAnswer(
  field: { id: string; label: string; kind: string; options: string[] },
  profile: EducationProfile,
): { value: string } | null {
  const match = /^(start|end)-(month|year)--0$/.exec(field.id);
  if (
    !match ||
    field.label.replace(/\*/g, "").trim().toLowerCase() !==
      `${match[1]} date ${match[2]}`
  )
    return null;
  const key = `${match[1]}${match[2] === "month" ? "Month" : "Year"}` as
    "startMonth" | "startYear" | "endMonth" | "endYear";
  const education: Partial<ConfirmedEducation> | null =
    primaryEducation(profile);
  const value = education?.[key];
  if (!value || !["text", "select"].includes(field.kind)) return null;
  if (field.kind === "text" || !field.options.length) return { value };
  const options = field.options.filter(
    (o) => o.trim().toLowerCase() === value.toLowerCase(),
  );
  return options.length === 1 ? { value: options[0] } : null;
}
