import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyCompany, legacyOpening } from "./fixtures/legacy-records.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import { createWorkspace } from "../server/server.js";
import { listenOnEphemeralPort } from "./fixtures/ephemeral-port.js";
import {
  findOpeningByUrl,
  publishOpeningResearch,
} from "../server/opening-workflow.js";

function research(title: string, compensation = "$180,000-$210,000 base") {
  return {
    opening: {
      title,
      jobId: "",
      description:
        "Build React and Node.js applications with relational data, maintain integrations and support mature production systems for an established product team.",
      location: "Remote (US)",
      compensation,
      technicalFit: "High",
      remoteFit: "High",
      wlbOutlook: "Unknown",
      why: "Overlap with React and Node.js work.",
      concerns: "On-call unknown.",
      wlbEvidence: "Unknown",
      postingStatus: "open",
      skills: { required: ["React", "Node.js"], preferred: [] },
    },
    company: {
      companyId: "",
      name: "Acme",
      officialUrl: "https://acme.example",
      careersUrl: "https://acme.example/careers",
      description: "Software company",
      contactInfo: "https://acme.example/contact",
      contactType: "url",
      contactSourceUrl: "https://acme.example/contact",
    },
    sources: ["https://acme.example/careers"],
  };
}
const existing = (id: string, title: string, url: string) => ({
  id,
  company_id: "acme",
  company: "Acme, Inc.",
  title,
  url,
  retained: true,
  postingStatus: "open",
  location: "Remote - US",
  compensation: "Unknown",
  createdAt: "2026-09-01T00:00:00.000Z",
  firstImportedAt: "2026-09-01T00:00:00.000Z",
  hash: "existing-hash",
  technical_fit: "Medium",
});

test("publishing research for another advertisement merges into the existing active Opening", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-dedupe-"));
  const store = new Store(repositoryRoot, dir);
  try {
    store.put(
      "custom_company",
      "acme",
      legacyCompany({
        id: "acme",
        name: "Acme Inc",
        fields: { "Official site": "https://acme.example" },
      }),
    );
    store.put(
      "custom_opening",
      "o-title",
      legacyOpening(
        existing(
          "o-title",
          "Senior Software Engineer",
          "https://boards.greenhouse.io/acme/jobs/111",
        ),
      ),
    );
    store.put(
      "custom_opening",
      "o-req",
      legacyOpening(
        existing(
          "o-req",
          "Staff Platform Engineer",
          "https://boards.greenhouse.io/acme/jobs/222",
        ),
      ),
    );
    const importUrl = "https://www.linkedin.com/jobs/view/999";
    store.put(
      "task",
      "t1" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "t1",
        preset: "opening-research",
        importUrl,
        researchResult: research("Senior Software Engineer!"),
      } as Records["task"],
    );
    const merged = publishOpeningResearch(store, "t1");
    assert.equal(merged!.id, "o-title");
    assert.equal(merged!.personalOpening, true);
    assert.equal(merged!.createdAt, "2026-09-01T00:00:00.000Z");
    assert.equal(merged!.firstImportedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(merged!.url, "https://boards.greenhouse.io/acme/jobs/111");
    assert.equal(merged!.location, "Remote - US", "existing details are kept");
    assert.equal(merged!.technical_fit, "Medium");
    assert.equal(
      merged!.compensation,
      "$180,000-$210,000 base",
      "missing details are filled",
    );
    assert.deepEqual(merged!.alternateUrls, [importUrl]);
    assert.equal(store.get("task", "t1")!.matchedBy, "companyTitle");
    assert.equal(store.get("task", "t1")!.openingId, "o-title");
    assert.equal(store.list("custom_opening").length, 2);
    assert.ok(
      store
        .list("journal")
        .some((e) => e.type === "opening_merged" && e.entityId === "o-title"),
    );
    assert.equal(
      findOpeningByUrl(store, importUrl)?.id,
      "o-title",
      "the merged advertisement URL resolves to the same Opening",
    );
    // Same requisition on the employer site, different title wording.
    store.put(
      "task",
      "t2" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "t2",
        preset: "opening-research",
        importUrl: "https://acme.example/careers/job?gh_jid=222",
        researchResult: research("Staff Engineer, Platform"),
      } as Records["task"],
    );
    assert.equal(publishOpeningResearch(store, "t2")!.id, "o-req");
    assert.equal(store.get("task", "t2")!.matchedBy, "jobId");
    // Closed Openings are not merge targets.
    store.put(
      "custom_opening",
      "o-title" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...store.get("custom_opening", "o-title"),
        postingStatus: "closed",
      } as Records["custom_opening"],
    );
    store.put(
      "task",
      "t3" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "t3",
        preset: "opening-research",
        importUrl: "https://acme.example/careers/senior-swe",
        researchResult: research("Senior Software Engineer"),
      } as Records["task"],
    );
    const created = publishOpeningResearch(store, "t3");
    assert.notEqual(created!.id, "o-title");
    assert.equal(store.get("task", "t3")!.matchedBy, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("URL import matches an existing Opening by ATS requisition before creating research", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opening-dedupe-api-"));
  const { server, port } = await listenOnEphemeralPort();
  const workspace = await createWorkspace({
    root: repositoryRoot,
    dataDir: dir,
    port,
    connectAgent: false,
    watch: false,
  });
  server.on("request", workspace.app);
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
  const post = (url: string, body: any) =>
    fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  try {
    workspace.store.put(
      "custom_opening",
      "o-api",
      legacyOpening(
        existing(
          "o-api",
          "Senior Software Engineer",
          "https://boards.greenhouse.io/acme/jobs/333",
        ),
      ),
    );
    let response = await post("/api/openings/import", {
      url: "https://acme.example/careers?gh_jid=333&utm_source=x",
      clientRequestId: randomUUID(),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      openingId: "o-api",
      existing: true,
      matchedBy: "jobId",
    });
    response = await post("/api/openings/import", {
      url: "https://boards.greenhouse.io/acme/jobs/333?gh_src=abc",
      clientRequestId: randomUUID(),
    });
    assert.deepEqual(await response.json(), {
      openingId: "o-api",
      existing: true,
      matchedBy: "url",
    });
    assert.equal(workspace.store.list("task").length, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
