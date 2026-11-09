export const educationSchoolKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const degrees: Record<string, { label: string; rank: number }> = {
  "a.s.": { label: "Associate's Degree", rank: 2 },
  "a.a.": { label: "Associate's Degree", rank: 2 },
  "b.s.": { label: "Bachelor's Degree", rank: 3 },
  "b.a.": { label: "Bachelor's Degree", rank: 3 },
  "m.s.": { label: "Master's Degree", rank: 4 },
  "m.a.": { label: "Master's Degree", rank: 4 },
  "ph.d.": { label: "Doctor of Philosophy (Ph.D.)", rank: 5 },
};

export const educationDegreeLabel = (rank: number | undefined) =>
  Object.values(degrees).find((degree) => degree.rank === rank)?.label;

/** Read explicit completed education entries; do not infer dates or majors. */
export function educationFromResume(
  markdown: string,
  school: unknown,
  year = new Date().getUTCFullYear(),
) {
  const section =
    markdown.split(/^## EDUCATION\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const entries = section.split("\n").flatMap((line) => {
    if (
      /\b(expected|candidate|coursework|in progress|incomplete)\b/i.test(line)
    )
      return [];
    const match =
      /^\s*-\s+\*\*(A\.S\.|A\.A\.|B\.S\.|B\.A\.|M\.S\.|M\.A\.|Ph\.D\.)\s+(.+?)\*\*,\s*(.+),\s*(\d{4})\s*$/i.exec(
        line,
      );
    if (!match || Number(match[4]) > year || Number(match[4]) < 1900) return [];
    const degree = degrees[match[1].toLowerCase()];
    return [
      {
        degree: degree.label,
        rank: degree.rank,
        discipline: match[2].trim(),
        school: match[3].trim(),
        endYear: match[4],
      },
    ];
  });
  const selected =
    typeof school === "string"
      ? entries.filter(
          (e) => educationSchoolKey(e.school) === educationSchoolKey(school),
        )
      : [];
  return {
    education: selected.length === 1 ? selected[0] : null,
    highestDegreeRank: Math.max(0, ...entries.map((e) => e.rank)),
  };
}

/** Month-level bounds for documented professional roles; overlapping jobs count once. */
export function experienceFromResume(markdown: string, asOf = new Date()) {
  const section =
    markdown.split(/^## PROFESSIONAL EXPERIENCE\s*$/m)[1]?.split(/^## /m)[0] ??
    "";
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
  const monthPattern = months.join("|");
  const dates = new RegExp(
    `^\\*(${monthPattern}) (\\d{4}) to (?:(${monthPattern}) (\\d{4})|(Present))\\*\\s*$`,
    "gm",
  );
  const current = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
  const intervals = [...section.matchAll(dates)]
    .flatMap((m) => {
      const start = Number(m[2]) * 12 + months.indexOf(m[1]);
      const end = m[5] ? current : Number(m[4]) * 12 + months.indexOf(m[3]);
      return start <= end && end <= current ? [[start, end + 1]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
  if (!intervals.length) return null;
  const merged: number[][] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval[0] <= prior[1])
      prior[1] = Math.max(prior[1], interval[1]);
    else merged.push([...interval]);
  }
  const maximumMonths = merged.reduce(
    (sum, [start, end]) => sum + end - start,
    0,
  );
  return {
    minYears: Math.max(0, maximumMonths - 2 * merged.length) / 12,
    maxYears: maximumMonths / 12,
  };
}
