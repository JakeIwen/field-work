import type { Records } from "../../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyCompany, legacyTask } from "../fixtures/legacy-records.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { openFixtureWorkspace } from "../fixtures/http-workspace.js";
import { Store, sha256 } from "../../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "../fixtures/sample-workspace.js";
import { importRepository } from "../../server/importer.js";
import {
  canonicalPosting,
  validateOpeningResearch,
  publishOpeningResearch,
  startOpeningApplication,
  applicationDate,
  prepareOpeningResearch,
} from "../../server/opening-workflow.js";
import { contextTool } from "../../server/context-tools.js";
import {
  preparePostingDocumentBundle,
  questionReferenceId,
} from "../../server/question-context.js";
import { draftPath } from "../../server/bundles.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";
import { syncCompanyContacts } from "../../server/company-contacts.js";
import { normalizeFitCriteria } from "../../shared/fit-criteria.js";

function research(companyId = "") {
  return {
    opening: {
      title: "Senior Full Stack Engineer",
      jobId: "abc-123",
      description:
        "Build React and Node.js applications with relational data, maintain integrations and support mature production systems. Collaborate on an established product with clear responsibility for frontend and backend engineering.",
      location: "Remote US",
      compensation: "Unknown",
      technicalFit: "High",
      remoteFit: "High",
      wlbOutlook: "Unknown",
      why: "Application ownership and integrations overlap with the resume.",
      concerns: "On-call expectations are not published.",
      wlbEvidence: "Unknown",
      postingStatus: "open",
      skills: { required: ["React", "Node.js"], preferred: [] },
    },
    company: {
      companyId,
      name: "Example Company",
      officialUrl: "https://example.com",
      careersUrl: "https://example.com/careers",
      description: "Software company",
      contactInfo: "123 Example St, Chicago, IL",
      contactType: "address",
      contactSourceUrl: "https://example.com/contact",
    },
    sources: [
      "https://example.com/careers/abc-123",
      "https://example.com/contact",
    ],
  };
}
test("publication blocks excluded technology from captured posting even if research omits it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-exclusion-")),
    store = new Store(repositoryRoot, dir);
  try {
    store.put("settings", "main", {
      ...store.settings(),
      fitCriteria: normalizeFitCriteria({
        technologyExcludeTerms: ["C#", ".NET"],
      }),
    });
    const id = randomUUID();
    store.put(
      "task",
      id,
      legacyTask({
        id,
        preset: "opening-research",
        importUrl: "https://example.com/jobs/123",
        researchResult: research(),
        posting: { text: "Optional ASP.NET knowledge" },
      }),
    );
    assert.throws(() => publishOpeningResearch(store, id), /mentions \.NET/);
    assert.equal(store.openings().length, 0);
    assert.equal(store.list("custom_company").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("researched URL imports match companies, deduplicate and survive rescans/backups", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-workflow-"));
  const store = new Store(repositoryRoot, dir);
  try {
    store.put(
      "custom_company",
      "existing",
      legacyCompany({
        id: "existing",
        name: "Example Company Inc.",
        fields: { "Official site": "https://www.example.com/" },
      }),
    );
    const task = {
      id: randomUUID(),
      preset: "opening-research",
      importUrl: "https://example.com/careers/abc-123?utm_source=test",
      threadId: "research-thread",
      status: "running",
      context: {},
    };
    store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      task as Records["task"],
    );
    const prepared = prepareOpeningResearch(store, task);
    store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { ...task, ...prepared } as Records["task"],
    );
    assert.throws(
      () =>
        contextTool(store, "research-thread", "save_opening_research", {
          ...research(),
          sources: ["https://example.com/job", "job-posting.txt"],
        }),
      /sources\[1\].*Remove local filenames/,
    );
    contextTool(store, "research-thread", "save_opening_research", research());
    assert.equal(
      store.openings().length,
      0,
      "don't publish until the turn finishes",
    );
    const opening = publishOpeningResearch(store, task.id);
    assert.equal(opening!.company_id, "existing");
    assert.equal(opening!.contactInfo, "123 Example St, Chicago, IL");
    assert.equal(store.list("custom_company").length, 1);
    contextTool(store, "research-thread", "save_opening_research", {
      ...research(),
      opening: { ...research().opening, jobId: "corrected-requisition" },
    });
    assert.equal(
      publishOpeningResearch(store, task.id)!.job_id,
      "corrected-requisition",
      "follow-up corrections update the same Opening",
    );
    assert.equal(publishOpeningResearch(store, task.id)!.id, opening!.id);
    assert.throws(
      () =>
        contextTool(store, "research-thread", "save_opening_research", {
          ...research(),
          opening: { ...research().opening, jobId: "https://example.com/job" },
        }),
      /opening.jobId.*never a URL/,
    );
    store.put(
      "task",
      "research-again" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...task,
        id: "research-again",
        importUrl: "https://example.com/careers/abc-123",
        researchResult: research(),
      } as Records["task"],
    );
    assert.equal(
      publishOpeningResearch(store, "research-again")!.id,
      opening!.id,
    );
    assert.equal(store.openings().length, 1);
    store.import(await importRepository(repositoryRoot));
    assert.equal(
      store.opening(opening!.id)!.contactInfo,
      "123 Example St, Chicago, IL",
    );
    store.put(
      "cache_opening",
      "scanner-discovered-identity" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...opening,
        id: "scanner-discovered-identity",
        postingStatus: "closed",
        lastCheckedAt: "2099-01-01T00:00:00Z",
      } as Records["cache_opening"],
    );
    assert.equal(
      store
        .openings()
        .filter(
          (o) => canonicalPosting(o.url) === canonicalPosting(opening!.url),
        ).length,
      1,
    );
    assert.equal(
      store.opening(opening!.id)!.postingStatus,
      "closed",
      "a later scan must refresh vacancy status",
    );
    const exported = store.personalExport();
    assert.equal(exported.records.custom_opening.length, 1);
    assert.ok(
      exported.records.company_contact.some(
        (c: any) => c.companyId === "existing",
      ),
    );
    const a = startOpeningApplication(store, opening!.id);
    assert.equal(a.status, "preparing");
    assert.equal(a.submittedAt, undefined);
    assert.equal(a.employerContactInfo, opening!.contactInfo);
    const later = startOpeningApplication(store, opening!.id);
    assert.equal(later.id, a.id);
    assert.equal(later.startedAt, a.startedAt);
    assert.equal(later.applicationDate, a.applicationDate);
    store.put("application", a.id, {
      ...a,
      status: "applied",
      submittedAt: "2026-01-01T12:00:00Z",
    });
    assert.equal(startOpeningApplication(store, opening!.id).status, "applied");
    store.put(
      "task",
      "new-company" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...task,
        id: "new-company",
        importUrl: "https://second.example.org/jobs/1",
        researchResult: {
          ...research(),
          company: {
            ...research().company,
            name: "Second Company",
            officialUrl: "https://second.example.org",
            contactInfo: "https://second.example.org",
            contactType: "url",
          },
        },
      } as Records["task"],
    );
    const second = publishOpeningResearch(store, "new-company");
    assert.notEqual(second!.company_id, "existing");
    assert.equal(
      store.get("custom_company", second!.company_id)!.contactInfo,
      "https://second.example.org",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("URL identity preserves requisitions and application start uses configured local date", () => {
  assert.equal(
    canonicalPosting("https://example.com/jobs/1/?utm_source=x#apply"),
    canonicalPosting("https://example.com/jobs/1"),
  );
  assert.notEqual(
    canonicalPosting("https://example.com/jobs?gh_jid=1"),
    canonicalPosting("https://example.com/jobs?gh_jid=2"),
  );
  assert.equal(
    applicationDate("America/Chicago", new Date("2026-09-20T01:00:00Z")),
    "2026-09-19",
  );
});
test("company contacts propagate on reimport without overwriting application notes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "contact-workflow-"));
  const store = new Store(repositoryRoot, dir);
  try {
    store.import(await importRepository(repositoryRoot));
    for (const c of store.state().companies) assert.ok(c.contactInfo, c.name);
    for (const o of store.openings()) assert.ok(o.contactInfo, o.id);
    const o = store.openings()[0];
    const a = startOpeningApplication(store, o.id);
    store.put("application", a.id, {
      ...a,
      contacts: "Recruiter contact entered by Sam",
    });
    store.put("company_contact", o.company_id, {
      companyId: o.company_id,
      contactInfo: "Updated address",
      sourceUrl: "https://example.com",
      contactType: "address",
      checkedAt: "2099-01-01",
    });
    syncCompanyContacts(store);
    assert.equal(store.opening(o.id)!.contactInfo, "Updated address");
    assert.equal(
      store.get("application", a.id)!.employerContactInfo,
      "Updated address",
    );
    assert.equal(
      store.get("application", a.id)!.contacts,
      "Recruiter contact entered by Sam",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "combined application generates two private selectable PDFs and attaches both files",
  { skip: process.platform !== "darwin", timeout: 180000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "combined-documents-"));
    const store = new Store(repositoryRoot, dir);
    try {
      store.import(await importRepository(repositoryRoot));
      const opening = store.openings()[0];
      const a = startOpeningApplication(store, opening.id);
      const task: any = {
        id: randomUUID(),
        preset: "posting-application",
        context: { openingId: opening.id, applicationId: a.id },
        status: "running",
        threadId: "combined-thread",
        posting: {
          text: research().opening.description,
          hash: sha256(research().opening.description),
        },
        postingLabel: "Verification fixture",
      };
      store.put("task", task.id, task);
      const prepared = preparePostingDocumentBundle(store, task, {
        id: questionReferenceId,
        text: "Fixture context only",
        messages: [],
        hash: sha256("fixture"),
      });
      store.put("task", task.id, { ...task, ...prepared });
      const letter =
        "Dear hiring team,\n\nThis is a deterministic PDF workflow verification fixture, not an application letter for submission. The role involves maintaining established web applications and integrations.\n\nMy experience includes taking ownership of mature production systems, modernizing application components and keeping existing workflows operating. I work across frontend interfaces, backend APIs and relational application data.\n\nThis fixture checks that the combined workflow preserves the current resume sources, generates a private resume PDF, and saves a separate cover letter with selectable text. No new experience or metrics are claimed.\n\nThank you,\nSam Rivera";
      contextTool(store, "combined-thread", "write_application_source", {
        path: "cover_letter.txt",
        expectedHash: sha256(""),
        content: letter,
      });
      assert.equal(
        readFileSync(
          draftPath(
            store,
            task.id,
            `source-history/${sha256("cover_letter.txt")}/${sha256(letter)}.txt`,
          ),
          "utf8",
        ),
        letter,
      );
      store.put(
        "task",
        task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          ...store.get("task", task.id),
          status: "completed",
        } as Records["task"],
      );
      const result = await renderApplicationDocuments(
        store,
        task.id,
        "fixture-turn",
      );
      assert.equal(result.status, "ready", JSON.stringify(result));
      const docs = store.list("generated_document");
      assert.equal(docs.length, 2);
      assert.equal(new Set(docs.map((d) => d.id)).size, 2);
      assert.equal(store.get("application", a.id)!.documentIds.length, 2);
      assert.ok(docs.every((d) => d.openingId === opening.id));
      const repeat = await renderApplicationDocuments(
        store,
        task.id,
        "fixture-turn",
      );
      assert.deepEqual(repeat.documentIds, result.documentIds);
      for (const [file, hash] of Object.entries(prepared.bundle.sourceHashes))
        assert.equal(
          sha256(readFileSync(path.join(repositoryRoot, file))),
          hash,
        );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("Opening API reuses imports and generation, captures the local date, saves question context and downloads both files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-api-"));
  const workspace = await openFixtureWorkspace(repositoryRoot, dir);
  const base = workspace.base;
  const csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
  const request = (url: string, body: any) =>
    fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  const starts: any[] = [];
  // Protocol fixtures separately verify real adapter policy. This test isolates route orchestration, with no model/network calls.
  workspace.agent.connect = async () => ({ available: true }) as any;
  workspace.agent.status = () => ({ available: true }) as any;
  workspace.agent.start = async (input: any) => {
    starts.push(input);
    return {
      threadId: `fixture-${starts.length}`,
      turnId: `turn-${starts.length}`,
    } as any;
  };
  workspace.store.put("reference_context", questionReferenceId, {
    id: questionReferenceId,
    text: "Fixture reference",
    messages: [],
    hash: sha256("fixture"),
  });
  try {
    const opening = workspace.store.openings()[0];
    assert.ok(
      (opening.description?.length ?? 0) > 100,
      "The synthetic posting must be complete before route tests; never fetch a live board.",
    );
    const encoded = encodeURIComponent(opening.id);
    let response = await request("/api/openings/import", {
      url: `${opening.url}?utm_source=api-check`,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).openingId, opening.id);
    assert.equal(starts.length, 0);
    response = await request(`/api/openings/${encoded}/generate`, {
      clientRequestId: randomUUID(),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const task = await response.json();
    assert.equal(task.preset, "posting-application");
    assert.equal(starts[0].purpose, "documents");
    assert.ok(task.posting.text.includes(opening.title));
    const application = workspace.store.get(
      "application",
      task.context.applicationId,
    )!;
    assert.equal(application.status, "preparing");
    assert.equal(
      application.applicationDate,
      applicationDate(workspace.store.settings().timezone),
    );
    assert.equal(application.submittedAt, undefined);
    response = await request(`/api/openings/${encoded}/generate`, {});
    assert.equal((await response.json()).id, task.id);
    assert.equal(starts.length, 1);
    response = await request(`/api/openings/${encoded}/questions`, {
      question: "Why does this role fit?",
      clientRequestId: randomUUID(),
    });
    assert.equal(response.status, 200);
    const question = await response.json();
    assert.equal(question.context.openingId, opening.id);
    assert.equal(question.posting.hash, task.posting.hash);
    assert.equal(starts[1].purpose, "questions");
    assert.equal(workspace.store.list("application").length, 1);
    const docs = workspace.store
      .state()
      .documents.filter((d) => d.format === "pdf" && d.privacy === "private");
    const resume = docs.find((d) => d.kind === "resume")!;
    const letter = docs.find((d) => d.kind === "cover-letter")!;
    assert.ok(resume && letter);
    workspace.store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...workspace.store.get("task", task.id),
        status: "completed",
        documentResult: {
          status: "ready",
          documentIds: [resume.id, letter.id],
        },
      } as Records["task"],
    );
    response = await fetch(base + `/api/openings/${encoded}/documents`);
    assert.equal(response.status, 200);
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.equal(Object.keys(zip).length, 2);
    assert.deepEqual(
      Buffer.from(zip[resume.name]),
      readFileSync(workspace.store.objectPath(resume.hash)),
    );
    assert.deepEqual(
      Buffer.from(zip[letter.name]),
      readFileSync(workspace.store.objectPath(letter.hash)),
    );
    response = await request(`/api/openings/${encoded}/generate`, {});
    assert.equal((await response.json()).id, task.id);
    assert.equal(
      starts.length,
      2,
      "completed generation should reuse saved files",
    );
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(
      state.openings.find((o: any) => o.id === opening.id).applicationDate,
      application.applicationDate,
    );
  } finally {
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening research saves bounded list summaries alongside unchanged full evidence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-summary-"));
  const store = new Store(repositoryRoot, dir);
  try {
    const data: any = research();
    data.opening.priority = "C";
    data.company.priority = "B";
    const full = data.opening.technicalFit;
    data.opening.listSummary = {
      location: "US remote",
      technicalFit: "React/Node overlap",
      wlbOutlook: "On-call unknown",
      compensation: "Not published",
    };
    validateOpeningResearch(store, data);
    const id = randomUUID();
    store.put(
      "task",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id,
        preset: "opening-research",
        importUrl: data.sources[0],
        researchResult: data,
        status: "completed",
      } as Records["task"],
    );
    const opening = publishOpeningResearch(store, id);
    assert.deepEqual(opening!.listSummary, {
      ...data.opening.listSummary,
      technicalFit: "High",
      wlbOutlook: "Unknown",
    });
    assert.ok(opening);
    assert.equal(Object.hasOwn(opening, "priority"), false);
    assert.ok(
      store
        .state()
        .companies.every((company) => !Object.hasOwn(company, "priority")),
    );
    assert.equal(opening.technical_fit, full);
    assert.equal(opening!.description, data.opening.description);
    assert.equal(opening!.listSummarySourceHash, opening!.hash);
    data.opening.listSummary.technicalFit = "x".repeat(49);
    assert.throws(() => validateOpeningResearch(store, data), /listSummary/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new research keeps categorical assessments separate from full evidence and records sourced dates and pay", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-categories-"));
  const store = new Store(repositoryRoot, dir);
  try {
    const data: any = research();
    data.opening = {
      ...data.opening,
      wlbOutlook: "Uncertain",
      compensation:
        "Published USD base salary $140,000–$180,000; equity and benefits are separate.",
      assessmentDetails: {
        technicalFit:
          "React and Node overlap with the documented production work; specialized streaming experience is not established.",
        remoteFit:
          "US remote is explicit. Employer approval for work while traveling remains unknown.",
        wlbOutlook:
          "Employer flexibility claims are documented. Actual hours and pager frequency remain unverified.",
      },
      listSummary: {
        location: "US remote; travel policy unknown",
        technicalFit: "React/Node overlap",
        wlbOutlook: "On-call frequency unknown",
        compensation: "$140,000–$180,000 USD base",
      },
      firstPublishedAt: "2026-09-17T13:00:00Z",
      deadline: "2026-10-10",
      dateSources: {
        firstPublishedAt: data.sources[0],
        deadline: data.sources[0],
      },
    };
    const before = JSON.stringify(data);
    const id = randomUUID();
    store.put(
      "task",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id,
        importUrl: data.sources[0],
        researchResult: data,
      } as Records["task"],
    );
    const opening = publishOpeningResearch(store, id);
    assert.equal(
      JSON.stringify(data),
      before,
      "publication must not rewrite original research",
    );
    assert.equal(opening!.technical_fit, "High");
    assert.equal(opening!.wlb_outlook, "Uncertain");
    assert.deepEqual(
      opening!.assessmentDetails,
      data.opening.assessmentDetails,
    );
    assert.equal(opening!.assessmentSourceHash, opening!.hash);
    assert.equal(opening!.listSummary!.technicalFit, "High");
    assert.equal(opening!.listSummary!.wlbOutlook, "Uncertain");
    assert.equal(opening!.first_published, data.opening.firstPublishedAt);
    assert.equal(opening!.deadline, data.opening.deadline);
    assert.deepEqual(opening!.dateSources, data.opening.dateSources);
    assert.equal(opening!.createdAt, opening!.firstImportedAt);
    assert.ok(Number.isFinite(Date.parse(opening!.createdAt!)));
    assert.equal(opening!.compensation, data.opening.compensation);
    assert.deepEqual(
      opening!.salaryBands!.map((b: any) => [
        b.min,
        b.max,
        b.currency,
        b.basis,
      ]),
      [[140000, 180000, "USD", "published base"]],
    );
    assert.throws(
      () =>
        validateOpeningResearch(store, {
          ...data,
          opening: { ...data.opening, technicalFit: "High: React overlap" },
        }),
      /technicalFit must be/,
    );
    assert.throws(
      () =>
        validateOpeningResearch(store, {
          ...data,
          opening: {
            ...data.opening,
            assessmentDetails: {
              ...data.opening.assessmentDetails,
              remoteFit: " ",
            },
          },
        }),
      /assessmentDetails/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy prose remains available without invented ratings or annualized hourly compensation", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-legacy-assessment-"));
  const store = new Store(repositoryRoot, dir);
  try {
    const data: any = research();
    data.opening.technicalFit =
      "High: React, Node and mature systems match; Python would be new.";
    data.opening.remoteFit =
      "US remote; permitted states and travel approval are not established.";
    data.opening.wlbOutlook =
      "Uncertain: employer flexibility claims do not establish actual hours.";
    data.opening.compensation =
      "USD $150/hour, up to 25 hours/week; part-time, no benefits. Maximum stated weekly gross is $3,750, not guaranteed.";
    const id = randomUUID();
    store.put(
      "task",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id,
        importUrl: data.sources[0],
        researchResult: data,
      } as Records["task"],
    );
    const opening = publishOpeningResearch(store, id);
    assert.equal(opening!.technical_fit, "High");
    assert.equal(opening!.remote_fit, "Unknown");
    assert.equal(opening!.wlb_outlook, "Uncertain");
    assert.deepEqual(opening!.assessmentDetails, {
      technicalFit: data.opening.technicalFit,
      remoteFit: data.opening.remoteFit,
      wlbOutlook: data.opening.wlbOutlook,
    });
    assert.equal(opening!.compensation, data.opening.compensation);
    assert.deepEqual(opening!.salaryBands, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("research date validation requires precise valid dates and public source URLs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-date-validation-"));
  const store = new Store(repositoryRoot, dir);
  try {
    const data: any = research();
    data.opening.dateSources = { firstPublishedAt: null, deadline: null };
    data.opening.firstPublishedAt = null;
    data.opening.deadline = null;
    assert.doesNotThrow(() => validateOpeningResearch(store, data));
    for (const date of ["2026-02-30", "next Friday", "2026-09-20T12:00:00"]) {
      assert.throws(
        () =>
          validateOpeningResearch(store, {
            ...data,
            opening: { ...data.opening, firstPublishedAt: date },
          }),
        /firstPublishedAt must be/,
      );
    }
    assert.throws(
      () =>
        validateOpeningResearch(store, {
          ...data,
          opening: { ...data.opening, deadline: "2026-10-10" },
        }),
      /Known opening.deadline requires/,
    );
    for (const source of [
      "local-source.json",
      "http://localhost:4317/source",
      "ftp://example.com/job",
    ]) {
      assert.throws(
        () =>
          validateOpeningResearch(store, {
            ...data,
            opening: {
              ...data.opening,
              deadline: "2026-10-10",
              dateSources: { firstPublishedAt: null, deadline: source },
            },
          }),
        /dateSources.deadline must be/,
      );
    }
    assert.throws(
      () =>
        validateOpeningResearch(store, {
          ...data,
          opening: { ...data.opening, dateSources: { firstPublishedAt: null } },
        }),
      /dateSources requires/,
    );
    assert.doesNotThrow(() =>
      validateOpeningResearch(store, {
        ...data,
        opening: {
          ...data.opening,
          firstPublishedAt: "2026-09-17T13:00:00Z",
          dateSources: { firstPublishedAt: data.sources[0], deadline: null },
        },
      }),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("research refresh preserves original Added and Posted dates while an explicit null clears a deadline", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-date-refresh-"));
  const store = new Store(repositoryRoot, dir);
  try {
    const data: any = research();
    const id = randomUUID();
    const publish = () => {
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          id,
          importUrl: data.sources[0],
          researchResult: data,
        } as Records["task"],
      );
      return publishOpeningResearch(store, id);
    };
    let opening = publish();
    const earlier = "2026-09-01T12:00:00Z";
    store.put(
      "custom_opening",
      opening!
        .id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...opening,
        createdAt: earlier,
        firstImportedAt: earlier,
        first_published: "2026-08-31",
        deadline: "2026-10-10",
        dateSources: {
          firstPublishedAt: data.sources[0],
          deadline: data.sources[0],
        },
      } as Records["custom_opening"],
    );
    opening = publish();
    assert.equal(opening!.createdAt, earlier);
    assert.equal(opening!.firstImportedAt, earlier);
    assert.equal(opening!.first_published, "2026-08-31");
    assert.equal(opening!.deadline, "2026-10-10");
    data.opening.firstPublishedAt = null;
    data.opening.deadline = null;
    data.opening.dateSources = { firstPublishedAt: null, deadline: null };
    opening = publish();
    assert.equal(opening!.first_published, "2026-08-31");
    assert.equal(opening!.dateSources!.firstPublishedAt, data.sources[0]);
    assert.equal(opening!.deadline, null);
    assert.equal(opening!.dateSources!.deadline, null);
    assert.equal(opening!.createdAt, earlier);
    const legacy = { ...opening };
    delete legacy.createdAt;
    delete legacy.firstImportedAt;
    store.put(
      "custom_opening",
      opening!
        .id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      legacy as Records["custom_opening"],
    );
    opening = publish();
    assert.equal(
      opening!.createdAt,
      undefined,
      "research updates must not invent an original Added timestamp",
    );
    assert.equal(opening!.firstImportedAt, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
