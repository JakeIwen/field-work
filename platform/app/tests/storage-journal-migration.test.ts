import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/storage.js";
import {
  journalPruningMigrationVersion,
  migrateRoutineJournal,
} from "../server/storage-journal-migration.js";

const zero = { added: 0, updated: 0, restored: 0, missing: 0 };
const reindexDetails = {
  validSections: { companies: true, openings: true, documents: true },
  summary: {
    companies: zero,
    openings: zero,
    documents: zero,
    sourceFilesChanged: 0,
    incomplete: false,
  },
};
const retired: [string, string, unknown?][] = [
  ["task_created", "Questions task prepared"],
  [
    "autofill_fetch",
    "Greenhouse read succeeded (attempt 1)",
    { outcome: "succeeded", attempt: 1, status: 200 },
  ],
  ["application-autofill", "Saved a Greenhouse autofill script"],
  ["application-autofill", "Saved a lever autofill script"],
  ["application-autofill", "Saved a ashby autofill script"],
  ["application_preparation", "Queued combined application preparation"],
  ["application_preparation", "Queued answers-only preparation"],
  ["validation", "Draft validation passed"],
  ["application_documents_generated", "Generated 2 dated resume PDFs"],
  ["application_documents_generated", "Generated 1 dated cover-letter PDF"],
  [
    "personal_updated",
    "Opening reviewed when autofill script was copied",
    { scriptId: "script" },
  ],
  ["personal_updated", "Personal notes or workflow updated"],
  [
    "app_reload",
    "Stopped generations and reloaded the app",
    { interruptedTasks: 0, unconfirmedInterrupts: 0 },
  ],
  [
    "files_reindexed",
    "Local files reindexed. No changes found.",
    reindexDetails,
  ],
];
const kept: [string, string, unknown?][] = [
  ...retired.map(([, message, details]): [string, string, unknown?] => [
    "different_type",
    message,
    details,
  ]),
  ...retired.map(([type, message, details]): [string, string, unknown?] => [
    type,
    `${message} extra`,
    details,
  ]),
  ["task_created", "task prepared"],
  ["autofill_fetch", "Greenhouse read succeeded (attempt 1)"],
  [
    "autofill_fetch",
    "Greenhouse read succeeded (attempt 1)",
    { outcome: "failed", attempt: 1, status: 200 },
  ],
  [
    "autofill_fetch",
    "Greenhouse read succeeded (attempt 1)",
    { outcome: "succeeded", attempt: 2, status: 200 },
  ],
  [
    "autofill_fetch",
    "Greenhouse read succeeded (attempt 1)",
    { outcome: "succeeded", attempt: 1, status: 500 },
  ],
  [
    "autofill_fetch",
    "Greenhouse read succeeded (attempt 2)",
    { outcome: "succeeded", attempt: 2, status: 200 },
  ],
  [
    "autofill_fetch",
    "Greenhouse read retrying (attempt 1)",
    { outcome: "retrying", attempt: 1 },
  ],
  [
    "autofill_fetch",
    "Greenhouse read failed (attempt 3)",
    { outcome: "failed", attempt: 3 },
  ],
  ["validation", "Draft validation failed"],
  [
    "application_preparation_ready",
    "Combined application preparation finished",
  ],
  ["application_document_error", "PDF generation failed"],
  ["application-autofill", "Saved a Lever autofill script"],
  ["personal_updated", "Updated personal fields: notes", { fields: ["notes"] }],
  ["app_reload", "Stopped generations and reloaded the app"],
  [
    "app_reload",
    "Stopped generations and reloaded the app",
    { interruptedTasks: 1, unconfirmedInterrupts: 0 },
  ],
  [
    "app_reload",
    "Stopped generations and reloaded the app",
    { interruptedTasks: 0, unconfirmedInterrupts: 1 },
  ],
  [
    "app_reload",
    "Stopped generations and reloaded the app",
    {
      interruptedTasks: 0,
      unconfirmedInterrupts: 0,
      interruptedPreparations: 1,
    },
  ],
  ["files_reindexed", "Local files reindexed. No changes found."],
  [
    "files_reindexed",
    "Local files reindexed. No changes found.",
    {
      ...reindexDetails,
      summary: { ...reindexDetails.summary, incomplete: true },
    },
  ],
  [
    "files_reindexed",
    "Local files reindexed. No changes found.",
    {
      ...reindexDetails,
      summary: { ...reindexDetails.summary, sourceFilesChanged: 1 },
    },
  ],
  [
    "files_reindexed",
    "Local files reindexed. No changes found.",
    {
      ...reindexDetails,
      summary: { ...reindexDetails.summary, openings: { ...zero, updated: 1 } },
    },
  ],
  [
    "files_reindexed",
    "Local files reindexed. No changes found.",
    {
      ...reindexDetails,
      validSections: { ...reindexDetails.validSections, documents: false },
    },
  ],
  [
    "application_submitted",
    "Submission recorded when autofill script was copied",
  ],
  ["opening_dismissal_migration", "Converted 2 openings to Not interested"],
];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "journal-migration-"));
  const data = path.join(root, "data");
  const store = new Store(root, data);
  store.db
    .prepare("DELETE FROM migrations WHERE version=?")
    .run(journalPruningMigrationVersion);
  return { root, data, store };
}

test("startup prunes exactly retired journal messages and retains migration provenance once", () => {
  const f = fixture();
  try {
    for (const [type, message, details] of retired)
      f.store.journal(type, message, "one", details);
    const survivors = kept.map(([type, message, details]) =>
      f.store.journal(type, message, "one", details),
    );
    f.store.close();
    const reopened = new Store(f.root, f.data);
    try {
      assert.deepEqual(
        reopened.list("journal"),
        JSON.parse(JSON.stringify(survivors)),
      );
      const migration = reopened.db
        .prepare("SELECT details FROM migrations WHERE version=?")
        .get(journalPruningMigrationVersion);
      assert.deepEqual(JSON.parse(String(migration?.details)), {
        removedJournalEntries: retired.length,
      });
      const later = reopened.journal(retired[0][0], retired[0][1]);
      assert.equal(migrateRoutineJournal(reopened), false);
      assert.ok(reopened.get("journal", later.id));
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("journal pruning and its provenance roll back together on failure", () => {
  const f = fixture();
  try {
    const entries = retired
      .slice(0, 2)
      .map(([type, message, details]) =>
        f.store.journal(type, message, "one", details),
      );
    f.store.db.exec(
      `CREATE TRIGGER block_pruning BEFORE DELETE ON records WHEN OLD.id='${entries[1].id}' BEGIN SELECT RAISE(ABORT,'blocked'); END`,
    );
    assert.throws(() => migrateRoutineJournal(f.store), /blocked/);
    assert.equal(f.store.list("journal").length, entries.length);
    assert.equal(
      f.store.db
        .prepare("SELECT 1 FROM migrations WHERE version=?")
        .get(journalPruningMigrationVersion),
      undefined,
    );
    f.store.db.exec("DROP TRIGGER block_pruning");
    assert.equal(migrateRoutineJournal(f.store), true);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
