// Editable fit criteria for careers-scan candidate filtering.
// Terms are matched case-insensitively as whole words; a space inside a term
// also matches "-" or nothing (so "full stack" matches "full-stack" and
// "fullstack"). The server compiles these into the regexes previously
// hardcoded in careers-providers.ts candidate().
export type FitCriteria = {
  seniorityTerms: string[]; // title must contain at least one
  titleRequireTerms: string[]; // title must contain at least one
  titleExcludeTerms: string[]; // title must contain none
  roleExcludeTerms: string[]; // title must contain none (non-IC or non-software roles)
  locationExcludeTerms: string[]; // location or "this role is/requires ..." sentence must contain none
  usLocationTerms: string[]; // location must contain at least one, contain a US state code, or be a bare remote/timezone label
  bodyRequireTerms: string[]; // description must contain at least one
  technologyExcludeTerms: string[]; // any mention in title/description excludes new listings
  remoteTerms: string[]; // location or body must indicate remote unless the feed flags remote
  version: number;
};
export const defaultFitCriteria: FitCriteria = {
  seniorityTerms: ["senior", "sr", "III", "IV", "lead", "full stack"],
  titleRequireTerms: [
    "software",
    "full stack",
    "front end",
    "back end",
    "web",
    "product",
    "developer",
    "API",
    "integration",
    "application",
  ],
  titleExcludeTerms: [
    "site reliability",
    "SRE",
    "devops",
    "infrastructure",
    "data engineer",
    "data engineering",
    "ML engineer",
    "mobile",
    "iOS",
    "Android",
    "Windows",
    "firmware",
    "kernel",
    "embedded",
    "storage engine",
    "security engineer",
    "Zendesk",
  ],
  roleExcludeTerms: [
    "manager",
    "director",
    "principal",
    "intern",
    "graduate",
    "junior",
    "sales",
    "support",
    "solutions",
    "salesforce",
    "firmware",
    "hardware",
    "electrical",
    "mechanical",
    "test automation",
    "quality assurance",
    "QA",
  ],
  locationExcludeTerms: ["onsite", "on-site", "hybrid"],
  usLocationTerms: [
    "united states",
    "US",
    "USA",
    "U.S.",
    "anywhere",
    "worldwide",
    "global",
    "north america",
    "americas",
  ],
  bodyRequireTerms: [
    "React",
    "TypeScript",
    "JavaScript",
    "Node.js",
    "SQL",
    "PostgreSQL",
    "MySQL",
    "API",
    "APIs",
    "full stack",
    "integration",
    "integrations",
  ],
  technologyExcludeTerms: [],
  remoteTerms: [
    "remote",
    "distributed",
    "anywhere",
    "home based",
    "fully remote",
    "100% remote",
    "US remote",
  ],
  version: 1,
};
export const fitCriteriaFields: {
  key: keyof Omit<FitCriteria, "version">;
  label: string;
  help?: string;
}[] = [
  {
    key: "seniorityTerms",
    label: "Seniority (title must include one)",
    help: "Skip roles below your level.",
  },
  {
    key: "titleRequireTerms",
    label: "Role keywords (title must include one)",
  },
  {
    key: "titleExcludeTerms",
    label: "Role keywords to exclude",
  },
  {
    key: "roleExcludeTerms",
    label: "Non-IC or non-software titles to exclude",
    help: "Management, sales, hardware, QA and similar.",
  },
  {
    key: "locationExcludeTerms",
    label: "Location words that disqualify",
    help: "Postings whose location matches any configured term are skipped.",
  },
  {
    key: "usLocationTerms",
    label: "Acceptable location words",
    help: 'Two-letter US state codes and a location that is only a remote indicator or US timezone (for example "Remote" or "EST") are always accepted.',
  },
  {
    key: "bodyRequireTerms",
    label: "Stack keywords (description must include one)",
  },
  {
    key: "technologyExcludeTerms",
    label: "Technologies to exclude anywhere in a posting",
    help: "Skip new listings mentioning these technologies, including optional or preferred skills. Existing saved listings are retained.",
  },
  {
    key: "remoteTerms",
    label: "Remote indicators",
    help: "Used when the feed does not flag the posting as remote.",
  },
];
type FitCriteriaInput = Partial<
  Record<keyof Omit<FitCriteria, "version">, unknown>
> & {
  version?: unknown;
};

export function normalizeFitCriteria(
  input: FitCriteriaInput | null | undefined,
): FitCriteria {
  const out: FitCriteria = { ...defaultFitCriteria };
  for (const f of fitCriteriaFields) {
    const v = input?.[f.key];
    if (Array.isArray(v))
      out[f.key] = [
        ...new Set(
          v.map((s) => String(s).trim()).filter((s) => s && s.length <= 60),
        ),
      ].slice(0, 100);
  }
  out.version = Number.isInteger(input?.version)
    ? (input as { version: number }).version
    : 1;
  return out;
}
