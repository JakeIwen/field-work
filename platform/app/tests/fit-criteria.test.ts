import test from "node:test";
import assert from "node:assert/strict";
import { candidate, type ScanJob } from "../server/careers/providers.js";
import {
  compileFitCriteria,
  termPattern,
  excludedTechnology,
} from "../server/fit-criteria.js";
import {
  defaultFitCriteria,
  normalizeFitCriteria,
} from "../shared/fit-criteria.js";

// The hardcoded filter that settings.fitCriteria replaced, kept verbatim for comparison.
function legacyCandidate(j: ScanJob) {
  const title = j.title,
    loc = j.location,
    body = j.description;
  const engineeringTitle = (s: string) =>
    /engineer|developer/i.test(s) &&
    !/manager|director|principal|intern|graduate|junior|sales|support|solutions|salesforce|firmware|hardware|electrical|mechanical|test automation|quality assurance|\bQA\b/i.test(
      s,
    );
  if (
    /talent (?:community|pool|network)|general application|expression of interest|future opportunit|register.*interest|open application/i.test(
      title,
    )
  )
    return false;
  if (
    j.listed === false ||
    !engineeringTitle(title) ||
    !/senior|\bsr\.?\b|\bIII\b|\bIV\b|lead|full.?stack/i.test(title)
  )
    return false;
  if (
    /\b(?:onsite|on-site|hybrid)\b/i.test(loc) ||
    /this (?:role|position) (?:is|requires)[^.\n]{0,40}(?:on.site|hybrid)/i.test(
      body,
    )
  )
    return false;
  const us =
    /united states|\bUSA?\b|U\.S\.|anywhere|worldwide|global|north america|americas/i.test(
      loc,
    ) ||
    /\b(?:WA|CA|NY|TX|IL|MA|CO|GA|NC|VA|PA|FL|AZ|UT|OR|DC)\b/.test(loc) ||
    /^(?:remote|distributed|PST|EST|CST|MST|PDT|EDT|US remote)$/i.test(
      loc.trim(),
    );
  if (!us) return false;
  if (
    !/software|full.?stack|front.?end|back.?end|web|product|developer|\bAPI\b|integration|application/i.test(
      title,
    ) ||
    /site.?reliability|\bSRE\b|devops|infrastructure|data engineer|data engineering|\bML engineer|mobile|iOS|Android|Windows|firmware|kernel|embedded|storage engine|security engineer|Zendesk/i.test(
      title,
    )
  )
    return false;
  if (
    !/React|TypeScript|JavaScript|Node\.?js|\bSQL\b|PostgreSQL|MySQL|\bAPIs?\b|full.?stack|integrations?/i.test(
      body,
    )
  )
    return false;
  return (
    j.remote === true ||
    /remote|distributed|anywhere|home.based/i.test(loc) ||
    /\b(?:fully|100%|US)[ -]remote\b/i.test(body)
  );
}

const job = (
  title: string,
  location: string,
  description: string,
  extra: Partial<ScanJob> = {},
): ScanJob => ({
  id: title,
  title,
  url: "https://example.com/j",
  location,
  description,
  salary: "",
  source: "fixture",
  at: "2026-09-01T00:00:00Z",
  ...extra,
});

test("technology exclusions match punctuation and aliases anywhere without treating ordinary net as .NET", () => {
  const criteria = normalizeFitCriteria({
    technologyExcludeTerms: ["C#", ".NET"],
  });
  for (const text of [
    "C#",
    "c#12",
    "C sharp",
    "CSharp",
    ".NET",
    ".NET8",
    ".NET Core",
    "ASP.NET",
    "dotnet",
    "dot net",
    "Nice to have: C#",
    "No .NET experience required",
  ])
    assert.ok(excludedTechnology(text, criteria), text);
  for (const text of [
    "net new clients",
    "internet networking",
    "Visit example.net",
    "React, Node.js and C++",
    "sharp focus",
    "dotnetify",
  ])
    assert.equal(excludedTechnology(text, criteria), undefined, text);
  assert.equal(
    candidate(
      job("Senior Software Engineer", "Remote US", "React. Preferred: C#."),
      criteria,
    ),
    false,
  );
  assert.equal(
    candidate(job("Senior .NET Engineer", "Remote US", "React."), criteria),
    false,
  );
  assert.equal(
    candidate(
      job("Senior Software Engineer", "Remote US", "React and Node.js."),
      criteria,
    ),
    true,
  );
});
const fixtures: [ScanJob, boolean][] = [
  [
    job("Senior Full Stack Engineer", "Remote - US", "Build React features."),
    true,
  ],
  [job("Senior Software Engineer", "Remote", "TypeScript services."), true],
  [
    job(
      "Senior Software Engineer",
      "San Francisco, CA (Hybrid)",
      "React and Node.js.",
    ),
    false,
  ],
  [
    job("Engineering Manager, Platform", "Remote US", "Lead React teams."),
    false,
  ],
  [job("Senior Backend Engineer", "Remote - Canada", "Node.js APIs."), false],
  [
    job(
      "Lead Frontend Developer",
      "United States",
      "JavaScript and design systems.",
      { remote: true },
    ),
    true,
  ],
  [
    job(
      "Senior Site Reliability Engineer",
      "Remote - US",
      "SQL and Terraform.",
    ),
    false,
  ],
  [job("Senior Software Engineer", "Remote, US", "Go and Kubernetes."), false],
  [job("Software Engineer", "Remote, USA", "React."), false],
  [
    job("Sr. Web Developer", "New York, NY", "Fully remote team using React."),
    true,
  ],
  [job("Senior Product Engineer", "EST", "Node.js and PostgreSQL."), false],
  [
    job("Talent Community - Senior Software Engineer", "Remote - US", "React."),
    false,
  ],
  [
    job(
      "Senior Integration Engineer",
      "Remote - US",
      "Integrations with REST APIs.",
      { listed: false },
    ),
    false,
  ],
  [
    job(
      "Senior Software Engineer",
      "Denver, CO",
      "This role is hybrid in Denver. React.",
    ),
    false,
  ],
  [
    job(
      "Senior Full-Stack Developer",
      "Anywhere",
      "PostgreSQL and TypeScript.",
    ),
    true,
  ],
  [job("Senior iOS Engineer", "Remote - US", "Swift and REST APIs."), false],
  [job("Senior Software Engineer", "Remote (Distributed)", "React."), false],
  [job("Senior Software Engineer II", "Sweden | Remote", "React."), false],
  [
    job(
      "Senior Applications Engineer",
      "North America (Remote)",
      "MySQL-backed integrations.",
    ),
    true,
  ],
  [job("Staff Software Engineer", "Remote - US", "React."), false],
];

test("default fit criteria reproduce the legacy candidate verdicts", () => {
  for (const [j, expected] of fixtures) {
    assert.equal(
      legacyCandidate(j),
      expected,
      `legacy fixture ${j.title} @ ${j.location}`,
    );
    assert.equal(candidate(j), expected, `compiled ${j.title} @ ${j.location}`);
    assert.equal(
      candidate(j, normalizeFitCriteria(structuredClone(defaultFitCriteria))),
      expected,
      `normalized ${j.title}`,
    );
  }
});

test("editing a criteria term list changes the verdict", () => {
  const goOnly = fixtures[7][0];
  assert.equal(candidate(goOnly), false);
  assert.equal(
    candidate(goOnly, {
      ...defaultFitCriteria,
      bodyRequireTerms: [...defaultFitCriteria.bodyRequireTerms, "Kubernetes"],
    }),
    true,
  );
  const fullStack = fixtures[0][0];
  assert.equal(
    candidate(fullStack, {
      ...defaultFitCriteria,
      titleExcludeTerms: [
        ...defaultFitCriteria.titleExcludeTerms,
        "full stack",
      ],
    }),
    false,
  );
  const staff = fixtures[19][0];
  assert.equal(
    candidate(staff, {
      ...defaultFitCriteria,
      seniorityTerms: [...defaultFitCriteria.seniorityTerms, "staff"],
    }),
    true,
  );
  const hybrid = job(
    "Senior Software Engineer",
    "Chicago, IL (Hybrid)",
    "React. US remote option.",
  );
  assert.equal(candidate(hybrid), false);
  assert.equal(
    candidate(hybrid, {
      ...defaultFitCriteria,
      locationExcludeTerms: ["onsite", "on-site"],
    }),
    true,
  );
});

test("terms escape metacharacters, match whole words, plurals and flexible separators", () => {
  const re = (term: string) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${termPattern(term)})(?![\\p{L}\\p{N}_])`,
      "iu",
    );
  assert.ok(re("full stack").test("Fullstack"));
  assert.ok(re("full stack").test("full-stack"));
  assert.ok(re("Node.js").test("NodeJS"));
  assert.ok(re("C++").test("Modern C++ code"));
  assert.ok(!re("C++").test("C code"));
  assert.ok(re("integration").test("Integrations Engineer"));
  assert.ok(!re("intern").test("Internal Tools"));
  assert.ok(re("100% remote").test("This is a 100% remote job"));
  assert.equal(
    compileFitCriteria({ ...defaultFitCriteria, bodyRequireTerms: [] })
      .bodyRequire,
    null,
    "an empty required list imposes no requirement",
  );
});
