import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MissingRecordError, Store, sha256 } from "../server/storage.js";
import { parseCompanies, parseOpenings } from "../server/importer.js";
import type { Document, ImportResult } from "../shared/types.js";
import { rescanMessage } from "../shared/rescan-summary.js";

const companyText =
  "## Example\n<!-- company_id: example -->\n- **Careers URL:** https://example.test/jobs\n";

test("state omits retired priority fields from legacy source and custom records without migrating them", async () =>
  fixture(async (_root, _dir, store) => {
    const imported = snapshot([]);
    const sourceCompany = imported.companies[0];
    const sourceOpening = imported.openings[0];
    store.put("cache_company", sourceCompany.id, {
      ...sourceCompany,
      priority: "B",
      fields: { ...sourceCompany.fields, "Monitoring priority": "B" },
    } as Records["cache_company"]);
    store.put("cache_opening", sourceOpening.id, {
      ...sourceOpening,
      priority: "B",
    });
    store.put("custom_company", "custom-company", {
      ...sourceCompany,
      id: "custom-company",
      priority: "A",
      fields: { ...sourceCompany.fields, "Monitoring priority": "A" },
    } as Records["custom_company"]);
    store.put("custom_opening", "custom-opening", {
      ...sourceOpening,
      id: "custom-opening",
      url: "https://example.test/custom",
      priority: "A",
    });
    const state = store.state();
    assert.equal(state.companies.length, 2);
    assert.equal(state.openings.length, 2);
    for (const company of state.companies) {
      assert.equal(Object.hasOwn(company, "priority"), false);
      assert.equal(Object.hasOwn(company.fields, "Monitoring priority"), false);
    }
    for (const opening of state.openings)
      assert.equal(Object.hasOwn(opening, "priority"), false);
    const retainedOpening = store.get("custom_opening", "custom-opening");
    const retainedCompany = store.get("custom_company", "custom-company");
    assert.ok(retainedOpening);
    assert.ok(retainedCompany);
    assert.equal(Object.hasOwn(retainedOpening, "priority"), true);
    assert.equal(Object.hasOwn(retainedCompany, "priority"), true);
  }));

test("rescan summaries count applied changes, document revisions once, disappearance and restoration", async () =>
  fixture(async (root, _dir, store) => {
    const file = path.join(root, "source_master_template/v10/resume.html");
    await writeFile(file, "original");
    let summary = store.import(snapshot([document("original")]));
    assert.equal(summary.companies.added, 1);
    assert.equal(summary.openings.added, 1);
    assert.equal(summary.documents.added, 1);
    summary = store.import({
      ...snapshot([
        { ...document("original"), modifiedAt: "2026-09-07T12:00:00Z" },
      ]),
      importedAt: "2026-09-07T12:00:00Z",
    });
    assert.equal(rescanMessage(summary), "No changes found.");
    await writeFile(file, "revised");
    const changed = snapshot([document("revised")]);
    changed.openings[0].title = "Updated title";
    changed.companies.push({
      ...changed.companies[0],
      id: "second",
      name: "Second company",
    });
    summary = store.import(changed);
    assert.equal(summary.openings.updated, 1);
    assert.equal(summary.companies.added, 1);
    assert.deepEqual(summary.documents, {
      added: 0,
      updated: 1,
      restored: 0,
      missing: 0,
    });
    assert.match(
      rescanMessage(summary),
      /1 opening updated, 1 company added, 1 document updated/,
    );
    assert.equal(
      // This fixture just emitted a files_reindexed journal entry with its import summary.
      (
        store.list("journal").at(-1)!.details as {
          summary: import("../shared/rescan-summary.js").RescanSummary;
        }
      ).summary.documents.updated,
      1,
    );
    summary = store.import({ ...changed, documents: [] });
    assert.equal(summary.documents.missing, 1);
    summary = store.import({ ...changed, documents: [] });
    assert.equal(rescanMessage(summary), "No changes found.");
    summary = store.import(changed);
    assert.equal(summary.documents.restored, 1);
    summary = store.import({
      ...changed,
      sourceHashes: { ...changed.sourceHashes, "context.md": "new-content" },
    });
    assert.match(
      rescanMessage(summary),
      /1 source file changed; no company, opening, or document changes/,
    );
  }));

test("partial rescans and failed document captures do not claim no changes or successful imports", async () =>
  fixture(async (root, _dir, store) => {
    await writeFile(
      path.join(root, "source_master_template/v10/resume.html"),
      "original",
    );
    store.import(snapshot([document("original")]));
    const partial = {
      ...snapshot(),
      companies: [],
      openings: [],
      validSections: { companies: false, openings: false, documents: false },
    };
    let summary = store.import(partial);
    assert.equal(summary.incomplete, true);
    assert.equal(summary.companies.missing, 0);
    assert.equal(summary.openings.missing, 0);
    assert.equal(summary.documents.missing, 0);
    assert.match(rescanMessage(summary), /^Rescan incomplete\./);
    assert.doesNotMatch(rescanMessage(summary), /No changes found/);
    summary = store.import(snapshot([document("changed-during-capture")]));
    assert.equal(summary.incomplete, true);
    assert.deepEqual(summary.documents, {
      added: 0,
      updated: 0,
      restored: 0,
      missing: 0,
    });
  }));

test("import reports missing metadata instead of publishing a successful rescan", async (t) =>
  fixture(async (_root, _dir, store) => {
    const transaction = store.transaction.bind(store);
    const persist = t.mock.method(store, "transaction", function <
      T,
    >(fn: () => T) {
      const result = transaction(fn);
      // Fault injection at the committed-import boundary exercises Store.import's
      // own guard, rather than a route's later read of the same metadata.
      store.remove("meta", "import");
      return result;
    });
    const exported = t.mock.method(store, "autoExport");
    assert.throws(
      () => store.import(snapshot()),
      (error: unknown) => {
        assert.ok(error instanceof MissingRecordError);
        assert.equal(error.status, 409);
        assert.equal(error.kind, "meta");
        assert.equal(error.id, "import");
        assert.equal(
          error.message,
          "Import metadata was not saved. Retry the rescan.",
        );
        return true;
      },
    );
    assert.equal(persist.mock.callCount(), 1);
    assert.equal(store.get("meta", "import"), undefined);
    assert.equal(exported.mock.callCount(), 0);
    assert.equal(
      store.list("journal").filter((entry) => entry.type === "files_reindexed")
        .length,
      0,
    );

    persist.mock.restore();
    assert.equal(store.import(snapshot()).incomplete, false);
    assert.ok(store.get("meta", "import"));
    assert.equal(exported.mock.callCount(), 1);
  }));

test("new source companies require an explicit watchlist decision after initial import", async () =>
  fixture(async (_root, _dir, store) => {
    store.import(snapshot());
    assert.equal(store.get("personal", "example")!.monitoring, true);
    const next = snapshot();
    next.companies.push({
      ...next.companies[0],
      id: "new-company",
      name: "New Company",
    });
    store.import(next);
    assert.equal(store.get("personal", "new-company")!.monitoring, false);
    assert.equal(store.get("personal", "new-company")!.pendingWatchlist, true);
    store.update("personal", "new-company", 0, {
      monitoring: true,
      pendingWatchlist: false,
    });
    store.import(next);
    assert.equal(store.get("personal", "new-company")!.monitoring, true);
  }));
const openingText =
  "### Example — Senior Engineer\n<!-- company_id: example; job_id: R1 -->\n* **Job URL:** https://example.test/R1\n* **Compensation:** Unknown\n* **Last confirmed open:** 2026-09-05\n";
function snapshot(documents: Document[] = []): ImportResult {
  return {
    companies: parseCompanies(companyText),
    openings: parseOpenings(openingText),
    documents,
    health: [],
    scan: {
      timestamp: "2026-09-05T21:39:45Z",
      seenCount: 3109,
      failedCompanies: ["blocked-example"],
      stateValid: true,
      history: "Verified previous scan history.",
    },
    sourceHashes: { companies: "valid-companies", openings: "valid-openings" },
    validSections: { companies: true, openings: true, documents: true },
    importedAt: "2026-09-06T12:00:00.000Z",
  };
}
function document(
  bytes: string,
  relative = "source_master_template/v10/resume.html",
): Document {
  const hash = sha256(bytes);
  return {
    id: `doc-${sha256(relative).slice(0, 20)}:${hash.slice(0, 20)}`,
    logicalId: `doc-${sha256(relative).slice(0, 20)}`,
    path: relative,
    hash,
    name: path.basename(relative),
    kind: "resume",
    scope: "general",
    company: null,
    version: "v10",
    versionNumber: 10,
    status: "current",
    privacy: "private",
    format: "html",
    authoredDate: null,
    dateProvenance: "Unknown; modification time is not authorship.",
    modifiedAt: "2026-09-06T11:00:00Z",
    text: bytes,
  };
}
async function fixture(
  fn: (root: string, dataDir: string, store: Store) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-search-state-"));
  await mkdir(path.join(root, "source_master_template/v10"), {
    recursive: true,
  });
  const dataDir = path.join(root, ".data");
  const store = new Store(root, dataDir);
  try {
    await fn(root, dataDir, store);
  } finally {
    try {
      store.close();
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}

test("repeated imports preserve stable populations and notes through database restart", async () =>
  fixture(async (root, dataDir, store) => {
    const bytes = "<p>Original resume</p>";
    await writeFile(
      path.join(root, "source_master_template/v10/resume.html"),
      bytes,
    );
    const initial = snapshot([document(bytes)]);
    store.import(initial);
    store.update("personal", "example:R1", 0, {
      saved: true,
      nextAction: "Ask about the on-call rotation",
      notes: "Strong technical fit",
      followUp: "2026-09-11",
    });
    store.autoExport();
    store.import(initial);
    store.import(initial);
    assert.equal(store.state().companies.length, 1);
    assert.equal(store.state().openings.length, 1);
    assert.equal(store.state().documents.length, 1);
    assert.equal(
      store.state().personal["example:R1"].nextAction,
      "Ask about the on-call rotation",
    );
    assert.equal(
      store.state().journal.filter((e) => e.type === "files_reindexed").length,
      1,
    );
    store.close();
    const reopened = new Store(root, dataDir);
    try {
      assert.equal(reopened.state().personal["example:R1"].saved, true);
      assert.equal(
        reopened.state().personal["example:R1"].followUp,
        "2026-09-11",
      );
      assert.equal(
        reopened.state().documents[0].firstImportedAt,
        initial.importedAt,
      );
      const backup = JSON.parse(
        await readFile(path.join(dataDir, "personal-export.json"), "utf8"),
      );
      assert.equal(
        backup.records.personal.find(
          (record: any) => record.id === "example:R1",
        ).nextAction,
        "Ask about the on-call rotation",
      );
    } finally {
      reopened.close();
    }
  }));

test("invalid scan and source imports retain prior valid populations, history and personal records", async () =>
  fixture(async (_root, _data, store) => {
    const good = snapshot();
    store.import(good);
    store.update("personal", "example:R1", 0, {
      dismissed: true,
      notes: "Keep the research history",
    });
    const invalid: ImportResult = {
      ...snapshot(),
      companies: [],
      openings: [],
      validSections: { companies: false, openings: false, documents: false },
      scan: {
        timestamp: null,
        seenCount: 0,
        failedCompanies: [],
        stateValid: false,
        history: "",
      },
      health: [
        {
          id: "invalid",
          category: "invalid-import",
          severity: "error",
          message: "Partial external save",
        },
      ],
      sourceHashes: {},
      importedAt: "2026-09-06T12:01:00Z",
    };
    store.import(invalid);
    const state = store.state();
    assert.equal(state.companies.length, 1);
    assert.equal(state.openings.length, 1);
    assert.equal(state.scan.seenCount, 3109);
    assert.equal(state.scan.timestamp, good.scan.timestamp);
    assert.deepEqual(state.scan.failedCompanies, ["blocked-example"]);
    assert.equal(state.scan.history, "Verified previous scan history.");
    assert.equal(state.scan.stateValid, false);
    assert.equal(state.personal["example:R1"].dismissed, true);
    assert.equal(state.health[0].category, "invalid-import");
  }));

test("an absent retained opening becomes unconfirmed history, and reappearance restores it without duplicates", async () =>
  fixture(async (_root, _data, store) => {
    store.import(snapshot());
    store.update("personal", "example:R1", 0, { saved: true });
    store.import({ ...snapshot(), openings: [] });
    let state = store.state();
    assert.equal(state.openings.length, 1);
    assert.equal(state.openings.filter((o) => o.retained !== false).length, 0);
    assert.equal(state.openings[0].postingStatus, "not confirmed open");
    assert.equal(state.personal["example:R1"].saved, true);
    store.import(snapshot());
    state = store.state();
    assert.equal(state.openings.length, 1);
    assert.equal(state.openings[0].retained, true);
    assert.equal(
      state.openings[0].postingStatus,
      "confirmed open at last scan",
    );
  }));

test("a changed file preserves immutable prior bytes and date uncertainty", async () =>
  fixture(async (root, _data, store) => {
    const oldText = "<p>Original facts</p>",
      newText = "<p>Revised facts</p>",
      oldDoc = document(oldText),
      newDoc = document(newText);
    await writeFile(path.join(root, oldDoc.path), oldText);
    store.import(snapshot([oldDoc]));
    const application = {
      id: "app",
      status: "applied",
      packages: [{ documents: [{ id: oldDoc.id, hash: oldDoc.hash }] }],
    };
    store.put(
      "application",
      "app" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      application as Records["application"],
    );
    await writeFile(path.join(root, oldDoc.path), newText);
    store.import({ ...snapshot([newDoc]), importedAt: "2026-09-06T13:00:00Z" });
    assert.equal(store.state().documents.length, 2);
    assert.equal(
      await readFile(store.objectPath(oldDoc.hash), "utf8"),
      oldText,
    );
    assert.equal(
      await readFile(store.objectPath(newDoc.hash), "utf8"),
      newText,
    );
    assert.equal(store.get("cache_document", oldDoc.id)!.status, "superseded");
    assert.equal(store.get("cache_document", newDoc.id)!.status, "current");
    assert.equal(store.get("cache_document", newDoc.id)!.authoredDate, null);
    assert.equal(
      store.get("application", "app")!.packages![0].documents[0].hash,
      oldDoc.hash,
    );
  }));

test("a file changing between parse and capture cannot erase the last valid document", async () =>
  fixture(async (root, _data, store) => {
    const previous = document("<p>Previously verified</p>");
    await writeFile(path.join(root, previous.path), previous.text);
    store.import(snapshot([previous]));
    const parsed = document("<p>Parsed snapshot</p>");
    await writeFile(
      path.join(root, previous.path),
      "<p>External concurrent edit</p>",
    );
    store.import(snapshot([parsed]));
    assert.equal(store.state().documents.length, 1);
    assert.equal(store.state().documents[0].id, previous.id);
    assert.equal(store.state().documents[0].status, "current");
    assert.equal(
      await readFile(store.objectPath(previous.hash), "utf8"),
      previous.text,
    );
    assert.ok(
      store
        .state()
        .health.some((h) => h.message.includes("Source changed during import")),
    );
  }));

test("partially invalid document trees accept verified additions and preserve unreadable prior paths", async () =>
  fixture(async (root, _data, store) => {
    const first = document("<p>First document</p>"),
      second = document(
        "<p>New draft</p>",
        "source_master_template/v10/draft.html",
      );
    await writeFile(path.join(root, first.path), first.text);
    store.import(snapshot([first]));
    await writeFile(path.join(root, second.path), second.text);
    store.import({
      ...snapshot([second]),
      validSections: { companies: true, openings: true, documents: false },
    });
    assert.equal(store.state().documents.length, 2);
    assert.equal(
      store.get("cache_document", first.id)!.availableInSource,
      true,
    );
    assert.equal(
      store.get("cache_document", second.id)!.immutableCopyAvailable,
      true,
    );
  }));
