import type {
  PullMetric,
  PullMetricMatch,
} from "../../shared/greenhouse-pull-metrics.js";

type ScreenRule = { pattern: RegExp; detail?: boolean };
const screenRules = {
  company: {
    pattern: /^Company filter: .+ is on your excluded companies list\.$/,
  },
  titleTerm: {
    pattern: /^Title triage: .+ matches your excluded title term “(.+)”\.$/,
    detail: true,
  },
  titleRole: {
    pattern:
      /^Title triage: .+ is not a software engineering or development title\.$/,
  },
  searchDate: { pattern: /^Older than \d+ days by search date$/ },
  publicationDate: {
    pattern:
      // Before October 2026 the screen said “Original employer publication is outside…”.
      /^Original (?:employer )?publication is outside the (?:seven|\d+)-day window/,
  },
  missingDate: {
    pattern: /^Official API has no usable original publication date\./,
  },
  technology: {
    pattern:
      /^Posting mentions (.+), which is excluded by your saved technology preferences\.$/,
    detail: true,
  },
  travelPercent: {
    pattern: /^Required travel exceeds the \d+(?:\.\d+)?% pull limit: “.+”\.$/,
  },
  unavailable: {
    pattern:
      /^Official (?:posting API confirms 404\/410;|feed marks this posting unlisted\.)/,
  },
  workflow: { pattern: /^Finishing review could not publish:/ },
  duplicate: {
    pattern:
      /^(?:Already saved in Fieldwork|Employer\/internal requisition matches an existing Fieldwork opening\.|Matches an existing Fieldwork opening \()/,
  },
} satisfies Partial<Record<PullMetric, ScreenRule>>;

export function classifyPullScreen(reason: string): PullMetricMatch[] {
  for (const [metric, rule] of Object.entries(screenRules)) {
    const match = rule.pattern.exec(reason);
    if (match)
      return [
        {
          metric: metric as PullMetric,
          ...("detail" in rule && rule.detail ? { detail: match[1] } : {}),
        },
      ];
  }
  return [{ metric: "otherScreen" }];
}

// Places that make a role non-US when a reason names them as the job location.
const nonUsPlaces = [
  "Canada",
  "Canadian",
  "Mexico",
  "LATAM",
  "Latin America",
  "South America",
  "Central America",
  "Europe",
  "European",
  "EMEA",
  "EU",
  "UK",
  "United Kingdom",
  "England",
  "London",
  "Ireland",
  "Germany",
  "France",
  "Spain",
  "Portugal",
  "Netherlands",
  "Poland",
  "Romania",
  "Ukraine",
  "Serbia",
  "Israel",
  "India",
  "Pune",
  "Bangalore",
  "Bengaluru",
  "Pakistan",
  "Philippines",
  "Singapore",
  "Hong Kong",
  "Taiwan",
  "Japan",
  "Korea",
  "China",
  "Australia",
  "New Zealand",
  "APAC",
  "Asia",
  "Brazil",
  "Argentina",
  "Colombia",
  "Chile",
  "Peru",
  "Uruguay",
  "Costa Rica",
  "Guatemala",
  "United Arab Emirates",
  "UAE",
  "Dubai",
  "Egypt",
  "Nigeria",
  "Kenya",
  "South Africa",
  "Turkey",
  "Greece",
  "Italy",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Switzerland",
  "Austria",
  "Belgium",
  "Czech",
  "Czechia",
  "CZ",
  "Prague",
  "Hungary",
  "Bulgaria",
  "Croatia",
  "Estonia",
  "Lithuania",
  "Latvia",
  "Vietnam",
  "Thailand",
  "Malaysia",
  "Indonesia",
].join("|");
const us = String.raw`(?:US|U\.S\.|United States)`;

// Ordered: the first match is the decision's primary ground, so each skip
// counts once and the shares add up to 100%. Named non-US places come before onsite
// wording, and onsite before the generic remote-eligibility phrasing that most
// location reasons repeat. Expertise is broad, so it sits after the specific
// grounds; unknown pay is never a skip ground, so compensation needs an
// explicit pay statement and comes last.
const reviewRules: [PullMetric, RegExp][] = [
  [
    "closed",
    /\b(?:posting (?:is |was |has been )?(?:closed|removed|expired)|no longer (?:available|accepting|listed|open)|job not found|returns? (?:a )?(?:404|410)|open status (?:remains |is )?(?:unresolved|unconfirmed|unverified)|open status could not be confirmed)\b/i,
  ],
  [
    "duties",
    /\b(?:outside (?:this|the) pull['’]?s? software|outside the (?:requested )?software (?:engineering|development)|rather than (?:a |an )?(?:software|engineering)|not (?:a |an )?(?:software|engineering|development) (?:engineering|development|role|position|vacancy)|not (?:primarily )?software (?:engineering|development)|product[- ]management|product manager|presales|pre-sales|sales engineer|customer (?:technical )?support|technical support|support role|IT operations|non[- ]software|not software work)\b/i,
  ],
  // Travel to customer sites is not a permanent onsite or country restriction.
  // "No travel required" is an aside in a location or onsite reason, not a travel ground.
  [
    "travel",
    /\b(?:(?:required?|mandatory|frequent|regular|extensive|heavy|excessive|monthly|weekly|overnight)\s+(?:\w+\s+){0,3}travel\b(?!\s+(?:industry|software|technology|platform)\b)|(?<!\bno\s)travel(?:l?ing)?\b(?!\s+(?:industry|software|technology|platform)\b)(?!\s+(?:is\s+|are\s+)?(?:not\s+(?:required|expected|needed)|optional)\b)[^.!?\n]{0,80}(?:\brequire\w*|\bmandatory\b|\bexceed\w*|\babove\b|\d+(?:\.\d+)?\s*%|\bmonthly\b|\bweekly\b|\b(?:per|each|every) month\b|\bfrequent\b|\bregular\b)|\d+(?:\.\d+)?\s*%\s+(?:of (?:the |working )?time )?travel\b|(?:monthly|weekly|multi[- ]day)\s+(?:\w+\s+){0,3}(?:client|customer)\s+(?:visits|trips)\b)/i,
  ],
  // A missing role-defining language is a stack gap, not generic remote eligibility.
  [
    "expertise",
    /\b(?:core[- ]language (?:gap|mismatch)|missing (?:core|primary) (?:programming )?language)\b|\b(?:core|primary|main|defining|implementation|programming) language\b[^.!?\n]{0,100}\b(?:absent|missing|unsupported|not (?:on|in|listed|among|supported))\b|\b(?:not (?:among|one of)|absent from|missing from)\b[^.!?\n]{0,80}\blanguages?\b|\blanguages?\b[^.!?\n]{0,80}\b(?:absent from|missing from|not (?:on|in|listed|supported))\b/i,
  ],
  [
    "location",
    new RegExp(
      String.raw`\b(?:outside (?:the )?${us}|(?:not|never) (?:open|available|eligible) (?:to|for|in) (?:the )?${us}|does not (?:permit|offer|allow|include|support) ${us}|(?:${nonUsPlaces})(?:[- ]based|[- ]only|, remote|\b))`,
      "i",
    ),
  ],
  [
    "onsite",
    /\b(?:hybrid|on[- ]?site|in[- ]office|in[- ]person|office (?:attendance|presence|days)|relocat\w+|commut\w+)\b/i,
  ],
  [
    "location",
    /\b(?:US[- ]compatible|US[- ]based employ\w*|remote eligibility|eligib\w+ (?:for|to work)|employment eligibility|job location|hiring locations?|location (?:restriction|requirement)|geograph\w*|time ?zone|regional role)\b/i,
  ],
  [
    "clearance",
    /\b(?:security clearance|clearance|citizenship|citizens?|ITAR|US persons?|export[- ]control)\b/i,
  ],
  // Require explicit scope wording; contract pay/location mentions keep their existing grounds.
  [
    "employmentType",
    /\bemployment[- ]type (?:out of scope|outside (?:the |this |selected |requested )*scope)\b/i,
  ],
  [
    "engagement",
    /\b(?:contract[- ]to[- ]hire|fixed[- ]term|short[- ]term|temporary|internship|intern|part[- ]time|duration|apprentice\w*|1099|freelance)\b/i,
  ],
  [
    "seniority",
    /\b(?:people management|managing (?:engineers|teams|managers|people|an? [\w -]{0,30}team)|management (?:role|position|responsibilit\w+|experience)|director[- ]level|executive|leadership (?:role|requirement|experience)|(?:too )?junior|entry[- ]level|new[- ]grad\w*)\b/i,
  ],
  [
    "expertise",
    /\b(?:specializ\w+|specialist|expertise|years (?:of|in)|\d+\+? years|depth|qualification|proficien\w+|certif\w+|domain (?:experience|knowledge)|hands[- ]on|requires?|required|experience (?:with|in|gap|must)|(?:prior|previous) [\w ,-]{0,60}experience|not established by|unsupported|lacks?)\b/i,
  ],
  [
    "compensation",
    /\b(?:compensation|salary|pay (?:range|rate|band|is|of|below)|below (?:the|your) (?:salary|pay|floor)|unpaid|equity[- ]only|commission[- ]only)\b/i,
  ],
];

const primaryGround = (text: string) =>
  reviewRules.find(([, pattern]) => pattern.test(text))?.[0];

export function classifyPullReview(input: {
  reason: string;
  softwareAssessment?: string;
  remoteAssessment?: string;
  fitAssessment?: string;
}): PullMetricMatch[] {
  // The reason states the grounds. Assessments discuss every requirement, so
  // they are consulted only when the reason names none, and then only their
  // adverse sentences, so a supported requirement never becomes a ground.
  const adverse =
    /\b(?:not|no|lack\w*|gap|missing|require\w*|only|restricted|incompatib\w*|unresolved|unclear|insufficient|exclud\w*|below|unavailable|closed)\b/i;
  const assessments = [
    input.softwareAssessment,
    input.remoteAssessment,
    input.fitAssessment,
  ]
    .flatMap((text) => (text ?? "").split(/(?<=[.!?])\s+|\n+/))
    .filter((text) => adverse.test(text))
    .join("\n");
  const metric =
    primaryGround(input.reason) ?? primaryGround(assessments) ?? "otherReview";
  return [{ metric }];
}
