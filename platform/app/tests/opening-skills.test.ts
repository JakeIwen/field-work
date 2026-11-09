import test from "node:test";
import assert from "node:assert/strict";
import {
  openingSkills,
  openingSkillGroups,
  validOpeningSkills,
  skillsInText,
  skillMatchesQuery,
} from "../shared/opening-skills.js";

const skills = (requirements: string) => openingSkills({ requirements });

test("skill chips canonicalize explicit aliases and deduplicate repeated mentions", () => {
  assert.deepEqual(
    skills(
      "Java Script, JS, Javascript; TypeScript/TS; Postgres/PostgreSQL; Amazon Web Services (AWS); Ruby on Rails and Rails.",
    ),
    ["AWS", "JS", "PostgreSQL", "Rails", "Ruby", "TS"],
  );
  assert.deepEqual(
    skills(
      "Node.js, NodeJS, Node/TypeScript; Next.js; Vue.js; K8s; C++; C#; .NET",
    ),
    [".NET", "C#", "C++", "Kubernetes", "Next.js", "Node.js", "TS", "Vue"],
  );
});

test("requirements are the only source and named frameworks do not invent language chips", () => {
  const opening = {
    requirements: "Use Next.js and Django. Experience with Rails is a plus.",
    why: "The applicant has Python, Ruby and JavaScript experience.",
    technical_fit: "High: AWS skills.",
  };
  assert.deepEqual(openingSkills(opening), ["Django", "Next.js", "Rails"]);
  assert.deepEqual(
    skills("Distributed systems, APIs, caching, and mentoring."),
    [],
  );
  assert.deepEqual(skills(""), []);
});

test("language names and tools do not match ordinary words or unrelated identifiers", () => {
  assert.deepEqual(skills("R"), ["R"]);
  assert.deepEqual(skills("C"), ["C"]);
  assert.deepEqual(
    skills(
      "Go where the problem is. You can go, work and grow. React calmly. Express yourself. Spring into action. REST assured. Our S+R team uses HR tools and payment rails. Node graphs have a root node. Cursor position and database cursors.",
    ),
    [],
  );
  assert.deepEqual(
    skills(
      "You can go where the problem is and express your ideas. Take a rest, or react calmly. Springtime. Our S+R team uses HR tools and payment rails. Node graphs have a root node. C-suite leadership; R&D; playwrights. cursor position.",
    ),
    [],
  );
  assert.deepEqual(
    skills(
      "Write production Go. Go skills, Python, R; C/C++; strong React experience. GitHub Actions.",
    ),
    ["C", "C++", "GitHub Actions", "Go", "Python", "R", "React"],
  );
});

test("full descriptions omit customer and investor names without losing the role stack", () => {
  assert.deepEqual(
    skills(
      "Our customers include OpenAI, Snap Inc., and Snowflake.\nAlpaca is backed by $400 million from investors including Spark Capital.\nYour role\nBuild services in Go with Kubernetes and Google Cloud Platform.\nNice to have\nUse Snowflake and Apache Spark for analytics.",
    ),
    ["GCP", "Go", "Kubernetes", "Snowflake", "Spark"],
  );
  assert.deepEqual(
    skills(
      "Our customers include OpenAI and Snowflake. We are backed by Spark Capital.\nStrong Go skills; Docker, OCI and Kubernetes.",
    ),
    ["Docker", "Go", "Kubernetes", "OCI"],
  );
});

test("technical links keep their label while URLs and markup do not invent skills", () => {
  assert.deepEqual(
    skills(
      '[Python](https://example.com/java) and <b>Postgres</b>. See https://example.com/ruby for benefits. <a href="https://react.dev">Our mission</a>',
    ),
    ["PostgreSQL", "Python"],
  );
});

test("technical backing retains databases while financial backing is omitted", () => {
  assert.deepEqual(
    skills(
      "We are venture-backed by Snowflake. Our investors include Spark Capital.\nBuild APIs backed by PostgreSQL and Redis. Build analytics backed by Snowflake.",
    ),
    ["PostgreSQL", "Redis", "Snowflake"],
  );
  assert.deepEqual(
    skills(
      "We are backed by leading investors Snowflake and Spark Capital.\nBuild APIs backed by PostgreSQL and Redis.",
    ),
    ["PostgreSQL", "Redis"],
  );
});

test("specialized current requirements retain test, data, integration and AI tools", () => {
  assert.deepEqual(
    skills(
      "Python frameworks (Django, FastAPI, Ninja). JUnit/TestNG, PyTest, k6, JMeter, Pact. RESTful APIs, GraphQL, OAuth 2.0, SAML, SCIM. LLM-based workflows and MCP servers. dbt, Airflow, n8n.",
    ),
    [
      "Airflow",
      "dbt",
      "Django",
      "Django Ninja",
      "FastAPI",
      "GraphQL",
      "JMeter",
      "JUnit",
      "k6",
      "LLMs",
      "MCP",
      "n8n",
      "OAuth",
      "Pact",
      "Pytest",
      "Python",
      "REST",
      "SAML",
      "SCIM",
      "TestNG",
    ],
  );
});

test("skill extraction follows changed requirements and callers cannot mutate cached chips", () => {
  const opening = { requirements: "Python" };
  const found = openingSkills(opening);
  found.push("Ruby");
  assert.deepEqual(openingSkills(opening), ["Python"]);
  opening.requirements = "JavaScript";
  assert.deepEqual(openingSkills(opening), ["JS"]);
});

test("picker search accepts canonical names, familiar aliases and punctuation variants", () => {
  for (const query of ["JS", "java script", "Javascript", "ecma"]) {
    assert.equal(skillMatchesQuery("JS", query), true, query);
  }
  assert.equal(skillMatchesQuery("GCP", "Google Cloud"), true);
  assert.equal(skillMatchesQuery("Node.js", "node js"), true);
  assert.equal(skillMatchesQuery("PostgreSQL", "postgres"), true);
  assert.equal(skillMatchesQuery("C++", "C#"), false);
  assert.equal(skillMatchesQuery("Ruby", "Rust"), false);
  assert.equal(skillMatchesQuery("Ruby", ""), true);
});

test("code-page names do not imply Windows experience in postings or resume text", () => {
  for (const text of [
    "Windows-1252",
    "windows-1251",
    "Windows‑1252",
    "Windows–1252",
  ]) {
    assert.deepEqual(skills(text), []);
    assert.deepEqual(skillsInText(text), []);
  }
  assert.deepEqual(skillsInText("myWindows Microsoft.Windows WindowsTool"), []);
  assert.deepEqual(
    skillsInText("Windows 11, Windows Server; Windows-1252 text"),
    ["Windows"],
  );
  assert.deepEqual(
    skillsInText(
      "# Experience\nPython, React and Node.js\n# Skills\nSQLite and Python",
    ),
    ["Node.js", "Python", "React", "SQLite"],
  );
});

test("classified skill groups canonicalize names, drop unknowns and let required win overlaps", () => {
  const opening = {
    requirements: "Ruby and Rails",
    skills: {
      required: ["Postgres", "Go", "PostgreSQL", "Unlisted Future Tool"],
      preferred: ["Python", "PostgreSQL", "JavaScript", "Go"],
    },
    hash: "current",
    skillsSourceHash: "current",
  };
  assert.deepEqual(openingSkillGroups(opening), {
    required: ["Go", "PostgreSQL"],
    anyOf: [],
    preferred: ["JS", "Python"],
  });
  assert.deepEqual(openingSkills(opening), [
    "Go",
    "JS",
    "PostgreSQL",
    "Python",
  ]);
  const groups = openingSkillGroups(opening);
  groups.required.push("Ruby");
  groups.preferred.length = 0;
  assert.deepEqual(openingSkillGroups(opening).preferred, ["JS", "Python"]);
  assert.deepEqual(openingSkillGroups(opening).required, ["Go", "PostgreSQL"]);
});

test("classified groups win without a source hash but stale or invalid lists fall back to mentions", () => {
  const opening = {
    requirements: "React and Node.js. Python is a plus.",
    skills: { required: ["React"], preferred: ["Python"] },
    hash: "current",
  };
  assert.deepEqual(openingSkillGroups(opening), {
    ...opening.skills,
    anyOf: [],
  });
  assert.deepEqual(
    openingSkillGroups({ ...opening, skillsSourceHash: "old" }),
    { required: ["Node.js", "Python", "React"], anyOf: [], preferred: [] },
  );
  assert.deepEqual(
    openingSkillGroups({
      ...opening,
      skills: { required: ["bad\nname"], preferred: [] },
    }),
    { required: ["Node.js", "Python", "React"], anyOf: [], preferred: [] },
  );
  opening.skills.required = ["Postgres"];
  assert.deepEqual(openingSkillGroups(opening).required, ["PostgreSQL"]);
  opening.skills.preferred.push("Go");
  assert.deepEqual(openingSkillGroups(opening).preferred, ["Go", "Python"]);
});

test("any-of requirements canonicalize alternatives, collapse implied groups and exclude grouped preferences", () => {
  const opening = {
    requirements: "Legacy description is not the classified source.",
    skills: {
      required: ["React"],
      anyOf: [
        ["Postgres", "MySQL", "PostgreSQL"],
        ["Go", "Unlisted Future Tool"],
        ["React", "Vue"],
        ["MySQL", "PostgreSQL"],
        ["Go", "Python"],
        ["Unlisted Future Tool"],
      ],
      preferred: ["Postgres", "MySQL", "Go", "React", "Redis"],
    },
  };
  const expected = {
    required: ["Go", "React"],
    anyOf: [["MySQL", "PostgreSQL"]],
    preferred: ["Redis"],
  };
  assert.deepEqual(openingSkillGroups(opening), expected);
  assert.deepEqual(openingSkills(opening), [
    "Go",
    "MySQL",
    "PostgreSQL",
    "React",
    "Redis",
  ]);
  const groups = openingSkillGroups(opening);
  groups.anyOf[0].push("Ruby");
  groups.anyOf.push(["Java", "Python"]);
  assert.deepEqual(openingSkillGroups(opening), expected);
  opening.skills.anyOf = [["Java", "Python"]];
  assert.deepEqual(openingSkillGroups(opening).anyOf, [["Java", "Python"]]);
});

test("classified skill validation accepts bounded empty lists and rejects malformed names or groups", () => {
  assert.equal(validOpeningSkills({ required: [], preferred: [] }), true);
  assert.equal(
    validOpeningSkills({
      required: ["x".repeat(60)],
      preferred: Array(60).fill("Go"),
    }),
    true,
  );
  for (const anyOf of [
    [],
    [["Go"]],
    [["Go", "Python"]],
    Array.from({ length: 20 }, () => Array(10).fill("Go")),
  ])
    assert.equal(
      validOpeningSkills({ required: [], preferred: [], anyOf }),
      true,
    );
  for (const anyOf of [
    "Go",
    ["Go"],
    [[]],
    [Array(11).fill("Go")],
    Array.from({ length: 21 }, () => ["Go"]),
    [["Go\nPython"]],
    [["x".repeat(61)]],
  ])
    assert.equal(
      validOpeningSkills({ required: [], preferred: [], anyOf }),
      false,
    );
  for (const value of [
    { required: ["Go\rPython"], preferred: [] },
    { required: ["Go\nPython"], preferred: [] },
    { required: [3], preferred: [] },
    { required: [], preferred: Array(61).fill("Go") },
    { required: [], preferred: ["x".repeat(61)] },
    { required: [" "], preferred: [] },
    { required: [] },
    [],
    null,
  ])
    assert.equal(validOpeningSkills(value), false);
});
