import assert from "node:assert/strict";
import test from "node:test";
import { pullTitleExclusion } from "../server/opening-pull/title-triage.js";
import {
  advanceUntil,
  at,
  card,
  fixture,
  posting,
} from "./fixtures/greenhouse-pull-fixture.js";
import { searchUrl } from "../server/greenhouse-source.js";
import { normalizeFitCriteria } from "../shared/fit-criteria.js";
import { legacyOpening } from "./fixtures/legacy-records.js";

const excludedTitles = [
  "Proofreader (Remote, Contract)",
  "Mental Health Therapist (Part-Time, W-2)",
  "Meteorologist (Contract)",
  "Data Analyst (Contract)",
  "Product Manager",
  "Product Director",
  "Fractional Account Executive",
  "Fractional Senior Communications Consultant",
  "Recruiter - Crew and Operations",
  "Technical Project Manager (Consultant)",
  "PM, Compute Platform",
  "VP, Client Delivery",
  "AP Processor (Part-Time Contract)",
  "Peer Support Specialist - Part Time",
  "Intelligence Operations Assistant, Part-Time (Remote)",
  "Part Time Prior Authorizations Nurse (RN) (Temporary)",
  "Clinical Psychologist- Part Time",
  "Designer-Contract",
  "Contract Analyst",
  "Presweeper",
  "Worldwide Operations",
  "Bioscience Analyst",
];
const reviewTitles = [
  "Software Engineer III",
  "Lead Engineer",
  "Frontend Architect",
  "Senior Application Developer",
  "SR Desenvolvimento Full-Stack (Node + React)",
  "Engenharia de Software Backend Sênior - Python | Fabrikam (Remoto)",
  "Software Engineer - Internal Tools (ENG-1234)",
  "Lead Research Engineer (part-time)",
  "SAP Integration Engineer CPI/BTP (Part time)",
  "Solutions Engineer",
  "Software Trainer",
  "Engineering Manager",
  "Engenheiro de Dados",
  "Ingeniero de datos",
  "Ingeniería de datos",
  "Ingénieur principal",
  "Développeur principal",
  "Desenvolvedor Sênior",
  "Desarrollador principal",
  "Senior Entwickler",
  "Development Lead",
  "Programmer",
  "Programming Intern",
  "Senior SWE",
  "SDE II",
  "Fullstack Consultant",
  "FULL—STACK",
  "Full / Stack",
  "Back End Specialist",
  "Back-End Specialist",
  "Front End Specialist",
  "Front-End Specialist",
  "DevOps",
  "Dev Ops",
  "Dev-Ops",
  "SRE",
  "Site-Reliability Lead",
  "Web Specialist",
  "Mobile Specialist",
  "iOS Specialist",
  "Android Specialist",
  "Platform Lead",
  "Tech-Lead",
  "Technical Lead",
  "CTO",
  "Chief Technology Officer",
  "Coder",
  "Software Engineers",
  "Développeur",
  "PM, Software Platform",
];

test("title triage excludes non-software families with the original title in its reason", () => {
  for (const title of excludedTitles)
    assert.equal(
      pullTitleExclusion(title),
      `Title triage: “${title}” is not a software engineering or development title.`,
      title,
    );
});

test("title triage conservatively retains software role families and normalized variants", () => {
  for (const title of reviewTitles)
    assert.equal(pullTitleExclusion(title), undefined, title);
});

test("saved title exclusions use the existing whole-word matcher and apply during discovery", async () => {
  const criteria = normalizeFitCriteria({
    titleExcludeTerms: ["data engineer", "engineering manager"],
  });
  assert.match(
    pullTitleExclusion("DATA-ENGINEERS", criteria)!,
    /excluded title term “data engineer”/,
  );
  assert.equal(pullTitleExclusion("Metadata Engineer", criteria), undefined);
  assert.equal(
    pullTitleExclusion(
      "Data Engineering",
      normalizeFitCriteria({ titleExcludeTerms: [] }),
    ),
    undefined,
  );
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      status: 200,
      at: new Date(at).toISOString(),
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      more: false,
      cards: [
        { ...card("1"), title: "Data Engineer" },
        { ...card("2"), title: "Engineering Manager" },
        card("3"),
      ],
    }),
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      fitCriteria: criteria,
    });
    const run = f.manager.start();
    await f.manager.tick();
    const rows = f.manager.ledger(run.id).candidates;
    assert.deepEqual(
      rows.map((row) => row.state),
      ["excluded", "excluded", "discovered"],
    );
    assert.equal(
      rows[0].reason,
      "Title triage: “Data Engineer” matches your excluded title term “data engineer”.",
    );
    assert.equal(
      rows[1].reason,
      "Title triage: “Engineering Manager” matches your excluded title term “engineering manager”.",
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.list("task").length, 0);
  } finally {
    await f.close();
  }
});

test("pull excludes a non-software card before fetching or creating research, while software proceeds", async () => {
  const nonSoftware = { ...card("1"), title: "Proofreader (Remote, Contract)" };
  const software = card("2");
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      cards: [nonSoftware, software],
      more: false,
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => f.manager.state()?.excluded === 1);
    assert.deepEqual(
      f.calls.filter((call) => call.posting),
      [],
    );
    assert.deepEqual(f.store.list("task"), []);
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    const candidates = f.manager.ledger(run.id).candidates;
    const excluded = candidates.find((candidate) => candidate.card.id === "1");
    const reviewing = candidates.find((candidate) => candidate.card.id === "2");
    assert.ok(excluded);
    assert.ok(reviewing);
    assert.equal(excluded.state, "excluded");
    assert.equal(excluded.reason, pullTitleExclusion(nonSoftware.title));
    assert.equal(excluded.posting, undefined);
    assert.equal(excluded.taskId, undefined);
    assert.notEqual(excluded.reviewed, true);
    assert.equal(reviewing.state, "reviewing");
    assert.ok(reviewing.posting);
    assert.ok(reviewing.taskId);
    assert.equal(f.store.list("task").length, 1);
    assert.equal(f.store.get("task", reviewing.taskId)?.status, "running");
    assert.deepEqual(
      f.calls.filter((call) => call.posting),
      [{ posting: "2" }],
    );
    assert.equal(f.manager.state()?.reviewed, 0);
    assert.equal(f.manager.state()?.added, 0);
  } finally {
    await f.close();
  }
});

test("discovery batches every title exclusion and saved-record match before any per-candidate work", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      status: 200,
      at: new Date(at).toISOString(),
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      more: page < 2,
      cards:
        page === 1
          ? [
              { ...card("1"), title: "Proofreader" },
              { ...card("2"), title: "Account Executive" },
              { ...card("3"), title: "Product Manager" },
              card("4"),
              card("5"),
            ]
          : [card("6")],
    }),
  });
  try {
    const saved = legacyOpening({
      id: "saved",
      url: card("3").url,
      title: "Saved title",
      postingStatus: "closed",
      dismissed: true,
    });
    f.store.put("custom_opening", saved.id, saved);
    f.store.put(
      "cache_opening",
      "aliased",
      legacyOpening({
        id: "aliased",
        url: card("90").url,
        greenhouseAliases: [{ publicJobId: "4", urls: [card("4").url] }],
      }),
    );
    const run = f.manager.start();
    await f.manager.tick();
    const candidates = f.manager.ledger(run.id).candidates;
    assert.deepEqual(
      candidates.map((candidate) => [candidate.card.id, candidate.state]),
      [
        ["1", "excluded"],
        ["2", "excluded"],
        ["3", "existing"],
        ["4", "existing"],
        ["5", "discovered"],
      ],
    );
    assert.equal(candidates[0].reason, pullTitleExclusion("Proofreader"));
    assert.equal(candidates[1].reason, pullTitleExclusion("Account Executive"));
    assert.equal(candidates[2].openingId, saved.id);
    assert.equal(candidates[3].openingId, "aliased");
    assert.deepEqual(f.store.get("custom_opening", saved.id), saved);
    assert.equal(f.store.list("task").length, 0);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("legacy discovered cards still pass the same title guard before fetching", async () => {
  const f = fixture();
  try {
    const run = f.manager.start();
    await f.manager.tick();
    const candidate = f.manager.ledger(run.id).candidates[0];
    f.store.put("greenhouse_pull_candidate", candidate.id, {
      ...candidate,
      card: { ...candidate.card, title: "Proofreader" },
    });
    await f.manager.tick();
    const saved = f.store.get("greenhouse_pull_candidate", candidate.id);
    assert.equal(saved?.state, "excluded");
    assert.equal(saved?.reason, pullTitleExclusion("Proofreader"));
    assert.equal(f.calls.filter((call) => call.posting).length, 0);
  } finally {
    await f.close();
  }
});

test("title triage leaves captured postings and existing research tasks on the normal path", async () => {
  for (const capturedPosting of [false, true]) {
    const f = fixture();
    try {
      const run = f.manager.start(1);
      await f.manager.tick();
      if (!capturedPosting)
        await advanceUntil(f, () => f.store.list("task").length === 1);
      const candidate = f.manager
        .ledger(run.id)
        .candidates.find((c) => c.card.id === "1");
      assert.ok(candidate);
      if (!capturedPosting) assert.ok(candidate.taskId);
      const nonSoftware = {
        ...candidate,
        card: { ...candidate.card, title: "Contract Analyst" },
        posting: capturedPosting ? posting(candidate.card) : undefined,
        taskId: capturedPosting ? undefined : candidate.taskId,
        state: capturedPosting ? ("discovered" as const) : candidate.state,
      };
      f.store.put("greenhouse_pull_candidate", candidate.id, nonSoftware);
      await advanceUntil(f, () => {
        const current = f.store.get("greenhouse_pull_candidate", candidate.id);
        return Boolean(
          current?.taskId &&
          f.store.get("task", current.taskId)?.status === "running",
        );
      });
      const current = f.manager
        .ledger(run.id)
        .candidates.find((c) => c.id === candidate.id);
      assert.equal(current?.state, "reviewing");
      assert.equal(current?.reason, undefined);
      if (!capturedPosting) assert.equal(current?.taskId, candidate.taskId);
    } finally {
      await f.close();
    }
  }
});
