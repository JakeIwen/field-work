import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyApplication,
  legacyAutofill,
} from "./fixtures/legacy-records.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import { resumeVariantReport } from "../server/reports.js";

const H = (c: string) => c.repeat(64);
test("resume variant report groups sent packages by document hash, resolving autofill-copy scripts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "variant-report-"));
  const store = new Store(repositoryRoot, dir);
  try {
    store.put(
      "custom_opening",
      "o1" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "o1",
        company: "Acme",
        title: "Senior Engineer",
        url: "https://example.com/jobs/1",
      } as Records["custom_opening"],
    );
    store.put(
      "custom_opening",
      "o2" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "o2",
        company: "Beta",
        title: "Senior Developer",
        url: "https://example.com/jobs/2",
      } as Records["custom_opening"],
    );
    store.put(
      "generated_document",
      "g1" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "g1",
        hash: H("a"),
        kind: "resume",
        privacy: "private",
        scope: "tailored",
        company: "Acme",
        origin: "generated",
        createdAt: "2026-09-10T00:00:00Z",
        name: "r.pdf",
      } as Records["generated_document"],
    );
    store.put(
      "generated_document",
      "g2" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "g2",
        hash: H("b"),
        kind: "cover-letter",
        privacy: "private",
        scope: "tailored",
        company: "Beta",
        origin: "generated",
        createdAt: "2026-09-12T00:00:00Z",
        name: "c.pdf",
      } as Records["generated_document"],
    );
    store.put(
      "cache_document",
      "m12" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "m12",
        hash: H("c"),
        kind: "resume",
        privacy: "private",
        scope: "general",
        version: "v12",
        versionNumber: 12,
        status: "current",
        name: "resume.pdf",
      } as Records["cache_document"],
    );
    store.put(
      "application_autofill",
      "s1",
      legacyAutofill({
        id: "s1",
        openingId: "o2",
        attachments: [
          { id: "resume", documentId: "g1" },
          { id: "cover_letter", documentId: "g2" },
        ],
      }),
    );
    store.put(
      "application",
      "a1" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "a1",
        openingId: "o1",
        status: "interviewing",
        submittedAt: "2026-09-11T00:00:00Z",
        documentIds: ["g1"],
        packages: [
          {
            id: "p1",
            at: "2026-09-11T00:00:00Z",
            documents: [
              { id: "g1", hash: H("a"), kind: "resume", privacy: "private" },
            ],
          },
          {
            id: "p1b",
            at: "2026-09-13T00:00:00Z",
            documents: [
              { id: "g1", hash: H("a"), kind: "resume", privacy: "private" },
            ],
          },
        ],
      } as Records["application"],
    );
    store.put(
      "application",
      "a2",
      legacyApplication({
        id: "a2",
        openingId: "o2",
        status: "applied",
        submittedAt: "2026-09-14T00:00:00Z",
        documentIds: [],
        packages: [
          {
            id: "p2",
            at: "2026-09-14T00:00:00Z",
            documents: [],
            source: "autofill-copy",
            scriptId: "s1",
          },
        ],
      }),
    );
    store.put(
      "application",
      "a3" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "a3",
        openingId: null,
        status: "preparing",
        documentIds: ["m12"],
        packages: [],
      } as unknown as Records["application"],
    );
    store.put(
      "application",
      "a4" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "a4",
        openingId: null,
        status: "considering",
        documentIds: [],
        packages: [],
      } as unknown as Records["application"],
    );
    const report = resumeVariantReport(store);
    assert.equal(report.applicationsWithoutPackage, 2);
    // Most-used first, then newest generated; undated masters last.
    assert.deepEqual(
      report.rows.map((r) => r.hash),
      [H("a"), H("b"), H("c")],
    );
    const [tailored, cover, master] = report.rows;
    assert.equal(tailored.label, "Tailored resume · Acme");
    assert.equal(tailored.source, "generated");
    assert.equal(tailored.applications.length, 2);
    assert.deepEqual(tailored.stageCounts, { interviewing: 1, applied: 1 });
    assert.equal(
      tailored.applications.find((a) => a.applicationId === "a1")!
        .packageSentAt,
      "2026-09-13T00:00:00Z",
      "one entry per application, latest send",
    );
    assert.equal(
      tailored.applications.find((a) => a.applicationId === "a2")!.company,
      "Beta",
    );
    assert.equal(cover.kind, "cover-letter");
    assert.equal(cover.label, "Tailored cover letter · Beta");
    assert.equal(master.label, "Resume v12 (private)");
    assert.equal(master.source, "general-master");
    assert.deepEqual(master.stageCounts, { "preparing (not submitted)": 1 });
    assert.equal(master.applications[0].packageSentAt, null);
    assert.equal(master.applications[0].company, "Unknown company");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
