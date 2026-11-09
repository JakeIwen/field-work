import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyApplication } from "./fixtures/legacy-records.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { recordAutofillCopy } from "../server/autofill/copy.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "autofill-copy-"));
  const store = new Store(root, path.join(root, "data"));
  store.put(
    "cache_opening",
    "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      id: "one",
      title: "Engineer",
      company: "Example",
      hash: "current",
    } as Records["cache_opening"],
  );
  const script = 'console.log("fixture")';
  const scriptHash = sha256(script);
  atomicWrite(store.objectPath(scriptHash), script);
  store.put(
    "application_autofill",
    "script" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      id: "script",
      openingId: "one",
      scriptHash,
    } as Records["application_autofill"],
  );
  return {
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("copy records submission and current review, preserves metadata, and is idempotent", () => {
  const f = fixture();
  try {
    f.store.put("personal", "one", {
      id: "one",
      version: 3,
      notes: "Keep me",
      saved: true,
      reviewedHash: "old",
    });
    const first = recordAutofillCopy(f.store, "one", "script");
    assert.equal(first.status, "applied");
    assert.ok(first.submittedAt);
    const expectedFollowUp = new Date(`${first.applicationDate}T00:00:00Z`);
    expectedFollowUp.setUTCDate(expectedFollowUp.getUTCDate() + 9);
    assert.equal(first.followUp, expectedFollowUp.toISOString().slice(0, 10));
    assert.equal(first.submissionSource, "autofill-copy");
    assert.deepEqual(first.packages![0].documents, []);
    assert.equal(first.packages![0].scriptId, "script");
    const personal = f.store.get("personal", "one")!;
    assert.equal(personal.reviewedHash, "current");
    assert.equal(personal.notes, "Keep me");
    assert.equal(personal.saved, true);
    assert.deepEqual(
      recordAutofillCopy(f.store, "one", "script"),
      JSON.parse(JSON.stringify(first)),
    );
    assert.deepEqual(f.store.get("personal", "one"), personal);
    assert.equal(
      f.store.list("journal").filter((j) => j.type === "application_submitted")
        .length,
      1,
    );
  } finally {
    f.close();
  }
});

test("copy fills only missing follow-up dates, using the local submission date across DST and year boundaries", () => {
  const f = fixture();
  try {
    for (const [submittedAt, followUp, expected] of [
      ["2026-11-01T02:00:00Z", "", "2026-11-09"],
      ["2026-12-29T02:00:00Z", undefined, "2027-01-06"],
      ["2026-12-29T02:00:00Z", "2027-02-01", "2027-02-01"],
    ]) {
      const original = {
        id: "app",
        openingId: "one",
        version: 1,
        status: "interviewing",
        submittedAt,
        followUp,
        packages: [{ id: "original" }],
      };
      f.store.put(
        "application",
        "app" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        original as Records["application"],
      );
      const copied = recordAutofillCopy(f.store, "one", "script");
      assert.equal(copied.followUp, expected);
      assert.equal(copied.submittedAt, submittedAt);
      assert.equal(copied.status, "interviewing");
      assert.deepEqual(copied.packages, original.packages);
      if (followUp) assert.equal(copied.version, original.version);
    }
  } finally {
    f.close();
  }
});

test("copy freezes selected document versions and never replaces a submitted package or later status", () => {
  const f = fixture();
  try {
    const bytes = "%PDF fixture";
    const doc = {
      id: "resume",
      path: "resume.pdf",
      hash: sha256(bytes),
      name: "Resume",
      privacy: "private",
      format: "pdf",
      version: "v1",
      kind: "resume",
    };
    atomicWrite(f.store.objectPath(doc.hash), bytes);
    f.store.put(
      "generated_document",
      doc.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      doc as Records["generated_document"],
    );
    f.store.put(
      "application",
      "app",
      legacyApplication({
        id: "app",
        openingId: "one",
        version: 1,
        status: "preparing",
        applicationDate: "2026-09-20",
        documentIds: ["resume"],
        packages: [],
      }),
    );
    const first = recordAutofillCopy(f.store, "one", "script");
    assert.deepEqual(first.packages![0].documents, [doc]);
    assert.equal(first.applicationDate, "2026-09-20");
    f.store.put("application", "app", { ...first, status: "interviewing" });
    const again = recordAutofillCopy(f.store, "one", "script");
    assert.equal(again.status, "interviewing");
    assert.deepEqual(again.packages, first.packages);
    assert.equal(again.submittedAt, first.submittedAt);
  } finally {
    f.close();
  }
});

test("invalid script ownership or missing document leaves submission and review untouched", () => {
  const f = fixture();
  try {
    assert.throws(
      () => recordAutofillCopy(f.store, "other", "script"),
      /not found/,
    );
    assert.equal(f.store.list("application").length, 0);
    const app = {
      id: "app",
      openingId: "one",
      version: 1,
      status: "preparing",
      documentIds: ["missing"],
    };
    f.store.put(
      "application",
      app.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      app as Records["application"],
    );
    assert.throws(
      () => recordAutofillCopy(f.store, "one", "script"),
      /document is missing/,
    );
    assert.deepEqual(f.store.get("application", "app"), app);
    assert.equal(f.store.get("personal", "one"), undefined);
    assert.equal(f.store.list("journal").length, 0);
  } finally {
    f.close();
  }
});
