import {
  saveFixturePdf,
  saveCompletedDocumentTask,
} from "./fixtures/document-records.js";
import { currentDocumentWritingRules } from "../server/document-writing-status.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";
import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { legacyAutofill, legacyTask } from "./fixtures/legacy-records.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import {
  documentPostingHash,
  preparationDocument,
  reusableDocuments,
} from "../server/preparation-documents.js";
import {
  generateAutofill,
  savedAutofillScript,
  readAutofillProfile,
} from "../server/greenhouse-autofill.js";
import { unzipSync } from "fflate";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { HttpError } from "../server/storage.js";
import { openingGenerationCounts } from "../shared/opening-documents.js";
import {
  formDocumentSlots,
  preparationDocumentKinds,
  type ApplicationPreparation,
} from "../shared/application-preparation.js";

const sources = [
  "AGENTS.md",
  "source_data/README.md",
  "source_data/resume.md",
  "source_data/github_evidence_dossier.md",
];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "application-preparation-"));
  const store = new Store(root, path.join(root, ".local/data"));
  for (const p of sources) atomicWrite(path.join(root, p), "Fixture source");
  atomicWrite(
    path.join(root, ".local/greenhouse/profile.json"),
    JSON.stringify({
      version: 1,
      firstName: "Test",
      email: "test@example.com",
    }),
  );
  for (const id of ["one", "two"])
    store.put(
      "cache_opening",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id,
        company_id: "company",
        company: "Example",
        title: "Engineer",
        url: `https://job-boards.greenhouse.io/example/jobs/${id === "one" ? 123 : 456}`,
        hash: id,
        description: "A fixture role.",
      } as Records["cache_opening"],
    );
  let count = 0,
    scriptCount = 0;
  const created: string[] = [];
  function docs(
    taskId: string,
    openingId: string,
    kinds = ["resume", "cover-letter"],
  ) {
    const existingTask =
      store.get("task", taskId) ??
      legacyTask({ id: taskId, preset: "posting-application" });
    const ids = kinds.map(
      (kind) =>
        saveFixturePdf(
          store,
          {
            id: `${taskId}-${kind}`,
            openingId,
            kind,
            name: kind + ".pdf",
            status: "draft",
            generatedBy: taskId,
            createdAt: new Date().toISOString(),
          },
          Buffer.from("%PDF-1.4\nFixture " + kind),
        ).id,
    );
    saveCompletedDocumentTask(store, existingTask, openingId, ids, {
      writingRuleHashes: currentDocumentWritingRules(store, existingTask),
      sourceHashes: Object.fromEntries(
        sources.map((p) => [p, sha256("Fixture source")]),
      ),
    });
    return ids;
  }
  const deps = {
    changed() {},
    async generateScript(
      openingId: string,
      documentIds: string[],
      preparationId?: string,
    ) {
      const r = {
        id: "script-" + ++scriptCount,
        openingId,
        documentIds,
        preparationId,
        dynamicQuestions: [],
      };
      store.put("application_autofill", r.id, legacyAutofill(r));
      return r;
    },
    async createDocuments(run: any, preset: string) {
      const id = "task-" + ++count;
      created.push(id);
      const t = {
        id,
        preset,
        status: "handoff",
        context: { openingId: run.openingId },
      };
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        t as Records["task"],
      );
      return t;
    },
    async startTask(id: string) {
      const t = store.get("task", id);
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        { ...t, status: "running", threadId: "fixture" } as Records["task"],
      );
      return t;
    },
    async startAnswers(_record: AutofillRecord) {
      return null;
    },
  };
  const manager = new ApplicationPreparationManager(store, deps);
  return {
    root,
    store,
    manager,
    deps,
    docs,
    created,
    async cleanup() {
      await manager.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("deleting a run while form retrieval fails does not reject tick or recreate the run", async () => {
  const f = fixture(),
    pending = deferred<any>();
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    await f.manager.tick(); // queued -> form
    f.deps.generateScript = () => pending.promise;
    const tick = f.manager.tick();
    f.store.remove("application_preparation", run.id);
    assert.equal(
      f.manager.active(),
      true,
      "in-flight work is still active after record removal",
    );
    pending.reject(new Error("Late form retrieval failure"));
    await assert.doesNotReject(tick);
    assert.equal(f.manager.latest("one"), undefined);
    assert.equal(f.store.get("application_preparation", run.id), undefined);
    assert.equal(f.manager.active(), false);
    // The scheduler still advances unrelated/new work after this race.
    const next = f.manager.start("two");
    await f.manager.tick();
    assert.equal(
      f.store.get("application_preparation", next.id)?.phase,
      "form",
    );
  } finally {
    pending.resolve({ id: "late" });
    await f.cleanup();
  }
});

test("late successful form retrieval cannot resurrect a deleted or paused preparation", async () => {
  for (const removed of [true, false]) {
    const f = fixture(),
      pending = deferred<any>();
    try {
      const run = f.manager.start("one");
      assert.ok(run.applicationId);
      await f.manager.tick();
      f.deps.generateScript = () => pending.promise;
      const tick = f.manager.tick();
      if (removed) f.store.remove("application_preparation", run.id);
      else
        f.store.put("application_preparation", run.id, {
          ...f.manager.latest("one")!,
          status: "paused",
        });
      pending.resolve({ id: "late-script" });
      await tick;
      const saved = f.store.get("application_preparation", run.id);
      assert.equal(saved?.status, removed ? undefined : "paused");
      assert.equal(saved?.scriptId, undefined);
    } finally {
      pending.resolve({ id: "late" });
      await f.cleanup();
    }
  }
});

test("late packaging success cannot mark an application ready or journal completion after run deletion", async () => {
  const f = fixture(),
    pending = deferred<any>();
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    f.store.put("application_preparation", run.id, {
      ...run,
      status: "running",
      phase: "packaging",
    });
    f.deps.generateScript = () => pending.promise;
    const tick = f.manager.tick();
    f.store.remove("application_preparation", run.id);
    pending.resolve({ id: "late-package" });
    await tick;
    assert.equal(
      f.store.get("application", run.applicationId)?.status,
      "preparing",
    );
    assert.equal(
      f.store
        .list("journal")
        .some((j) => j.type === "application_preparation_ready"),
      false,
    );
    assert.equal(f.manager.latest("one"), undefined);
  } finally {
    pending.resolve({ id: "late" });
    await f.cleanup();
  }
});

test("a removed application fails its surviving preparation deliberately instead of dereferencing it", async () => {
  const f = fixture(),
    pending = deferred<any>();
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    f.store.put("application_preparation", run.id, {
      ...run,
      status: "running",
      phase: "packaging",
    });
    f.deps.generateScript = () => pending.promise;
    const tick = f.manager.tick();
    f.store.remove("application", run.applicationId);
    pending.resolve({ id: "late-package" });
    await tick;
    assert.equal(f.manager.latest("one")?.status, "failed");
    assert.match(f.manager.latest("one")!.error!, /application was removed/);
    assert.equal(f.store.get("application", run.applicationId), undefined);
  } finally {
    pending.resolve({ id: "late" });
    await f.cleanup();
  }
});

test("a missing saved script is reported without calling the answer task dependency", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    f.store.put("application_preparation", run.id, {
      ...run,
      status: "running",
      phase: "answers",
      scriptId: "removed-script",
    });
    f.deps.startAnswers = async () => {
      calls++;
      return null;
    };
    await f.manager.tick();
    assert.equal(calls, 0);
    assert.equal(f.manager.latest("one")?.status, "failed");
    assert.match(f.manager.latest("one")!.error!, /script was removed/);
  } finally {
    await f.cleanup();
  }
});

test("scheduled ticks contain and report unexpected rejections", async (t) => {
  const f = fixture(),
    reported = deferred<unknown[]>();
  t.mock.method(console, "error", (...args: unknown[]) =>
    reported.resolve(args),
  );
  t.mock.method(f.manager, "tick", async () => {
    throw new Error("Unexpected persistence failure");
  });
  try {
    f.manager.start("one");
    // Keep the event loop alive while the production unref'd timer fires.
    const keepAlive = setTimeout(
      () => reported.reject(new Error("Scheduled error was not reported")),
      1000,
    );
    try {
      const args = await reported.promise;
      assert.equal(args.length, 1);
      assert.match(
        String(args[0]),
        /component=application-preparation .*Application preparation tick failed:/,
      );
      assert.match(String(args[0]), /Unexpected persistence failure/);
    } finally {
      clearTimeout(keepAlive);
    }
  } finally {
    await f.cleanup();
  }
});

test("prepare deduplicates clicks, runs multiple openings concurrently and reuses valid documents", async () => {
  const f = fixture();
  try {
    const first = f.manager.start("one");
    assert.equal(f.manager.start("one").id, first.id);
    const second = f.manager.start("two");
    assert.ok(first.applicationId && second.applicationId);
    assert.equal(
      f.store.get("application", first.applicationId)!.status,
      "preparing",
    );
    assert.equal(
      f.store.get("application", first.applicationId)!.submittedAt,
      undefined,
    );
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(f.created.length, 2);
    assert.equal(f.manager.latest("two")!.status, "running");
    assert.equal(f.store.get("task", f.created[0])!.status, "running");
    assert.equal(f.store.get("task", f.created[1])!.status, "running");
    f.docs(f.created[0], "one");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(f.manager.latest("one")!.status, "ready");
    assert.equal(
      f.store.get("application", first.applicationId)!.status,
      "ready",
    );
    assert.equal(
      f.store.get("application", first.applicationId)!.documentIds.length,
      2,
    );
    for (let i = 0; i < 5; i++) await f.manager.tick();
    f.docs(f.created[1], "two");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(f.manager.latest("two")!.status, "ready");
    const again = f.manager.start("one");
    for (let i = 0; i < 6; i++) await f.manager.tick();
    assert.equal(f.manager.latest("one")!.status, "ready");
    assert.equal(f.created.length, 2, "re-preparation reuses current PDFs");
    assert.notEqual(again.id, first.id);
    assert.equal(
      f.store.personalExport().records.application_preparation.length,
      3,
    );
    assert.deepEqual(f.store.state().openingGenerationCounts, {
      one: 2,
      two: 1,
    });
    assert.equal(
      f.store.get("application", second.applicationId)!.submittedAt,
      undefined,
    );
  } finally {
    await f.cleanup();
  }
});
test("ready preparations reuse immutable PDFs after developer instructions and templates change", async () => {
  const f = fixture();
  try {
    f.manager.start("one");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    const ids = f.docs(f.created[0], "one");
    const task = f.store.get("task", f.created[0]);
    assert.ok(task?.bundle);
    const template = "source_master_template/v12/resume_private.html";
    const renderer = "source_master_template/v12/render.swift";
    f.store.put("task", task.id, {
      ...task,
      bundle: {
        ...task.bundle,
        sourceHashes: {
          ...task.bundle.sourceHashes,
          [template]: sha256("Original template"),
          [renderer]: sha256("Original renderer"),
        },
      },
    });
    for (let i = 0; i < 5; i++) await f.manager.tick();
    const before = preparationDocument(f.store, "one", ids[0]);
    for (const file of [
      "AGENTS.md",
      "source_data/README.md",
      template,
      renderer,
    ])
      atomicWrite(
        path.join(f.root, file),
        "Updated app instructions or rendering",
      );
    assert.equal(f.manager.latest("one")?.stale, false);
    assert.deepEqual(
      reusableDocuments(f.store, "one").map((d) => d.id),
      ids,
    );
    assert.deepEqual(
      preparationDocument(f.store, "one", ids[0]).bytes,
      before.bytes,
    );
    f.manager.start("one");
    for (let i = 0; i < 6; i++) await f.manager.tick();
    assert.equal(f.created.length, 1, "no new document task is needed");
    assert.equal(f.manager.latest("one")?.status, "ready");
    atomicWrite(path.join(f.root, sources[3]), "Changed factual evidence");
    assert.equal(f.manager.latest("one")?.stale, true);
    assert.match(
      f.manager.latest("one")?.staleReasons?.join(" ") || "",
      /supporting experience dossier/,
    );
    assert.equal(reusableDocuments(f.store, "one").length, 0);
  } finally {
    await f.cleanup();
  }
});
test("preparation admits three openings and advances another when a slot is released", async () => {
  const f = fixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      parallelPreparations: 3,
    });
    for (const id of ["three", "four"])
      f.store.put(
        "cache_opening",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        { ...f.store.opening("one"), id } as Records["cache_opening"],
      );
    for (const id of ["one", "two", "three", "four"]) f.manager.start(id);
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(f.created.length, 3);
    assert.equal(f.manager.latest("four")!.status, "queued");
    f.docs(f.created[1], "two");
    for (let i = 0; i < 10; i++) await f.manager.tick();
    assert.equal(f.manager.latest("two")!.status, "ready");
    assert.equal(f.manager.latest("one")!.status, "running");
    assert.equal(
      f.created.length,
      4,
      "the later opening need not wait for the first task to finish",
    );
    assert.equal(f.manager.latest("four")!.status, "running");
  } finally {
    await f.cleanup();
  }
});
test("task failure is visible, stale/corrupt/cross-opening PDFs are rejected, and sent packages remain immutable", async () => {
  const f = fixture();
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    for (let i = 0; i < 5; i++) await f.manager.tick();
    const task = f.store.get("task", f.created[0])!;
    f.store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...task,
        status: "failed",
        error: "fixture failure",
      } as Records["task"],
    );
    await f.manager.tick();
    assert.equal(f.manager.latest("one")!.status, "failed");
    assert.match(f.manager.latest("one")!.error!, /fixture failure/);
    const ids = f.docs(task.id, "one");
    assert.equal(reusableDocuments(f.store, "one").length, 2);
    assert.throws(
      () => preparationDocument(f.store, "two", ids[0]),
      /this Opening/,
    );
    atomicWrite(path.join(f.root, sources[2]), "Changed resume");
    assert.equal(reusableDocuments(f.store, "one").length, 0);
    atomicWrite(path.join(f.root, sources[2]), "Fixture source");
    const app = f.store.get("application", run.applicationId)!;
    const pack = { id: "sent", documents: [{ id: "old" }] };
    f.store.put(
      "application",
      app.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...app,
        status: "applied",
        submittedAt: "2026-01-01T00:00:00Z",
        documentIds: ["old"],
        packages: [pack],
      } as unknown as Records["application"],
    );
    f.manager.start("one");
    for (let i = 0; i < 6; i++) await f.manager.tick();
    assert.equal(f.store.get("application", app.id)!.status, "applied");
    assert.deepEqual(f.store.get("application", app.id)!.packages, [pack]);
    assert.deepEqual(f.store.get("application", app.id)!.documentIds, ["old"]);
    const doc = f.store.document(ids[0])!;
    atomicWrite(f.store.objectPath(doc.hash), "%PDF-corrupted");
    assert.throws(
      () => preparationDocument(f.store, "one", ids[0]),
      /corrupted/,
    );
  } finally {
    await f.cleanup();
  }
});
test("successful PDF generation stays counted after final Greenhouse packaging fails", async () => {
  const f = fixture();
  try {
    f.manager.start("one");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    f.docs(f.created[0], "one");
    await f.manager.tick();
    assert.equal(f.manager.latest("one")!.phase, "answers");
    assert.equal(f.store.state().openingGenerationCounts?.one, 1);
    await f.manager.tick(); // Refresh inputs and move into final packaging.
    f.deps.generateScript = async () => {
      throw new Error("Could not read the current Greenhouse form.");
    };
    await f.manager.tick();
    assert.equal(f.manager.latest("one")!.status, "failed");
    assert.equal(f.manager.latest("one")!.phase, "packaging");
    assert.match(f.manager.latest("one")!.error!, /Greenhouse form/);
    assert.equal(f.manager.latest("one")!.documentIds.length, 2);
    assert.equal(f.store.state().openingGenerationCounts?.one, 1);
  } finally {
    await f.cleanup();
  }
});
test("restart pauses unfinished preparation instead of duplicating agent turns", async () => {
  const f = fixture();
  try {
    f.manager.start("one");
    await f.manager.close();
    const restored = new ApplicationPreparationManager(f.store, f.deps);
    assert.equal(restored.latest("one")!.status, "paused");
    assert.equal(f.created.length, 0);
    await restored.close();
  } finally {
    await f.cleanup();
  }
});
test("combined script contains exact validated PDF bytes and integrity metadata without polluting ordinary metadata", async () => {
  const f = fixture();
  try {
    const ids = f.docs("docs", "one");
    const api = {
      id: 123,
      title: "Engineer",
      questions: [
        { label: "First Name", fields: [{ name: "first_name" }] },
        { label: "Email", fields: [{ name: "email" }] },
        {
          label: "Resume/CV",
          required: true,
          fields: [{ name: "resume", type: "input_file" }],
        },
      ],
    };
    f.store.put(
      "task",
      "docs" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...f.store.get("task", "docs"),
        preparationPostingHash: documentPostingHash(api),
      } as Records["task"],
    );
    const html =
      '<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><div class="file-upload"><div id="upload-label-resume">Resume/CV*</div><label for="resume">Attach</label><input id="resume" type="file"></div><div class="file-upload"><div id="upload-label-cover_letter">Cover Letter</div><label for="cover_letter">Attach</label><input id="cover_letter" type="file"></div></form>';
    const result = await generateAutofill(
      f.store,
      "one",
      async (url) => ({
        url,
        requestedUrl: url,
        status: 200,
        type: url.includes("boards-api") ? "application/json" : "text/html",
        text: url.includes("boards-api") ? JSON.stringify(api) : html,
        at: new Date().toISOString(),
      }),
      { documentIds: ids, preparationId: "fixture" },
    );
    assert.equal(result.attachments!.length, 2);
    assert.equal("base64" in result.attachments![0], false);
    const script = savedAutofillScript(f.store, "one", result.id).script;
    assert.ok(
      script.includes(
        Buffer.from("%PDF-1.4\nFixture resume").toString("base64"),
      ),
    );
    assert.equal(
      result.review.some((r) => r.label === "Resume/CV"),
      false,
    );
    const zip = unzipSync(f.store.backup());
    assert.ok(zip[`objects/${result.scriptHash}`]);
    assert.ok(zip[`objects/${f.store.document(ids[0])!.hash}`]);
    assert.equal(f.store.list("application").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("profile edits during PDF generation are captured before answers with the finished attachments", async () => {
  const f = fixture();
  try {
    const generate = f.deps.generateScript;
    f.deps.generateScript = async (...args) => {
      const result = await generate(...args);
      const record = f.store.get("application_autofill", result.id);
      assert.ok(record);
      f.store.put("application_autofill", record.id, {
        ...record,
        profileHash: readAutofillProfile(f.store).hash,
      });
      return result;
    };
    let answered = false;
    f.deps.startAnswers = async (record) => {
      assert.equal(record.profileHash, readAutofillProfile(f.store).hash);
      assert.equal(record.preparationId, run.id);
      assert.equal(
        f.store.get("application_autofill", record.id)?.documentIds?.length,
        2,
      );
      answered = true;
      return null;
    };
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    for (let i = 0; i < 5; i++) await f.manager.tick();
    const originalScript = f.manager.latest("one")?.scriptId;
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Updated",
        email: "test@example.com",
      }),
    );
    f.docs(f.created[0], "one");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(answered, true);
    assert.equal(f.manager.latest("one")?.status, "ready");
    assert.notEqual(f.manager.latest("one")?.scriptId, originalScript);
    assert.equal(
      f.created.length,
      1,
      "profile changes do not regenerate the PDFs",
    );
  } finally {
    await f.cleanup();
  }
});

test("deleting preparation during answer refresh does not launch an answer task or resurrect work", async () => {
  const f = fixture(),
    pending = deferred<Awaited<ReturnType<typeof f.deps.generateScript>>>();
  try {
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    for (let i = 0; i < 5; i++) await f.manager.tick();
    f.docs(f.created[0], "one");
    await f.manager.tick();
    assert.equal(f.manager.latest("one")?.phase, "answers");
    let calls = 0;
    f.deps.startAnswers = async () => {
      calls++;
      return null;
    };
    f.deps.generateScript = () => pending.promise;
    const tick = f.manager.tick();
    f.store.remove("application_preparation", run.id);
    pending.resolve({
      id: "late",
      openingId: "one",
      documentIds: [],
      preparationId: undefined,
      dynamicQuestions: [],
    });
    await tick;
    assert.equal(calls, 0);
    assert.equal(f.manager.latest("one"), undefined);
  } finally {
    await f.cleanup();
  }
});

test("a stopped revision does not invalidate PDFs from its completed turn", async () => {
  const f = fixture();
  try {
    const ids = f.docs("previous", "one");
    const task = f.store.get("task", "previous");
    assert.ok(task?.documentResult);
    for (const id of ids) {
      const doc = f.store.get("generated_document", id);
      assert.ok(doc);
      f.store.put("generated_document", id, {
        ...doc,
        generatedTurnId: "finished",
      });
    }
    f.store.put("task", task.id, {
      ...task,
      status: "interrupted",
      documentRuns: { finished: task.documentResult },
      documentResult: {
        status: "failed",
        turnId: "stopped",
        error: "Reload app",
      },
    });
    assert.deepEqual(
      reusableDocuments(f.store, "one").map((d) => d.id),
      ids,
    );
  } finally {
    await f.cleanup();
  }
});

test("refreshing one material generates only that kind and retains the other PDF", async () => {
  const f = fixture();
  try {
    const original = f.docs("previous", "one");
    const run = f.manager.start("one", "resume");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.equal(f.created.length, 1);
    assert.equal(f.store.get("task", f.created[0])?.preset, "posting-resume");
    const refreshed = f.docs(f.created[0], "one", ["resume"]);
    const doc = f.store.get("generated_document", refreshed[0]);
    assert.ok(doc);
    f.store.put("generated_document", doc.id, {
      ...doc,
      createdAt: "2099-01-01T00:00:00Z",
    });
    for (let i = 0; i < 6; i++) await f.manager.tick();
    assert.equal(f.manager.latest("one")?.status, "ready");
    assert.deepEqual(f.manager.latest("one")?.documentIds, [
      refreshed[0],
      original[1],
    ]);
    assert.ok(f.store.document(original[0]), "older resume remains available");
    assert.ok(
      f.store
        .get("application_preparation", run.id)
        ?.replaceDocumentIds?.includes(original[0]),
    );
    assert.throws(
      () => Reflect.apply(f.manager.start, f.manager, ["one", "invalid"]),
      /Choose resume or cover-letter/,
    );
  } finally {
    await f.cleanup();
  }
});

test("phaseHistory is seeded as queued and gains one entry per phase transition", async () => {
  const f = fixture();
  try {
    const run = f.manager.start("one");
    assert.deepEqual(run.phaseHistory, [
      { phase: "queued", at: run.createdAt },
    ]);
    const seen = new Set<string>(["queued"]);
    for (let i = 0; i < 4; i++) {
      await f.manager.tick();
      const stored = f.store.get("application_preparation", run.id);
      assert.ok(stored);
      const history = stored.phaseHistory ?? [];
      // The last entry is the current phase, and entries are never rewritten.
      assert.equal(history.at(-1)?.phase, stored.phase);
      assert.equal(history[0]?.phase, "queued");
      assert.equal(history[0]?.at, run.createdAt);
      for (let j = 1; j < history.length; j++) {
        assert.notEqual(history[j].phase, history[j - 1].phase);
        assert.ok(history[j].at >= history[j - 1].at);
      }
      seen.add(stored.phase);
    }
    const final = f.store.get("application_preparation", run.id);
    assert.ok(seen.size > 1, "fixture advanced through at least one phase");
    assert.equal(final?.phaseHistory?.length, seen.size);
  } finally {
    await f.cleanup();
  }
});

/** A script-generation stub that saves a record carrying the inspected form's document slots. */
function scriptWithSlots(
  f: ReturnType<typeof fixture>,
  documentSlots?: AutofillRecord["documentSlots"],
) {
  let n = 0;
  f.deps.generateScript = async (openingId, documentIds, preparationId) => {
    const r = {
      id: `slot-script-${++n}`,
      openingId,
      documentIds,
      preparationId,
      dynamicQuestions: [],
      ...(documentSlots ? { documentSlots } : {}),
    };
    f.store.put("application_autofill", r.id, legacyAutofill(r));
    return r;
  };
}

test("a form without a cover-letter slot generates only the resume and links one PDF", async () => {
  const f = fixture();
  try {
    scriptWithSlots(f, ["resume"]);
    const run = f.manager.start("one");
    assert.ok(run.applicationId);
    for (let i = 0; i < 4; i++) await f.manager.tick();
    assert.deepEqual(f.manager.latest("one")?.documentKinds, ["resume"]);
    assert.equal(f.created.length, 1);
    assert.equal(f.store.get("task", f.created[0])?.preset, "posting-resume");
    assert.match(f.manager.latest("one")!.message, /tailored resume…$/);
    const ids = f.docs(f.created[0], "one", ["resume"]);
    // A legacy letter from an earlier run is neither attached nor linked.
    f.docs("legacy-letter", "one", ["cover-letter"]);
    for (let i = 0; i < 3; i++) await f.manager.tick();
    const saved = f.manager.latest("one")!;
    assert.equal(
      saved.phase === "answers" ||
        saved.phase === "packaging" ||
        saved.phase === "ready",
      true,
    );
    assert.deepEqual(saved.documentIds, ids);
    assert.deepEqual(
      f.store.get("application", run.applicationId)!.documentIds,
      ids,
    );
    for (let i = 0; i < 3; i++) await f.manager.tick();
    assert.equal(f.manager.latest("one")?.status, "ready");
    assert.equal(f.created.length, 1, "no cover-letter task is created");
    assert.equal(f.store.state().openingGenerationCounts?.one, 1);
  } finally {
    await f.cleanup();
  }
});

test("scripts without documentSlots and sites without a form still generate both documents", async () => {
  const f = fixture();
  try {
    f.store.put("cache_opening", "site", {
      ...f.store.opening("one"),
      id: "site",
      url: "https://example.com/careers/engineer",
    } as Records["cache_opening"]);
    f.manager.start("one"); // fixture scripts predate documentSlots
    f.manager.start("site"); // no supported application form
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.deepEqual(
      f.created.map((id) => f.store.get("task", id)?.preset),
      ["posting-application", "posting-application"],
    );
    assert.equal(f.manager.latest("site")?.supportedForm, false);
    assert.deepEqual(preparationDocumentKinds(f.manager.latest("one")!), [
      "resume",
      "cover-letter",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("explicit cover-letter regeneration is refused when the latest script's form has no slot", async () => {
  const f = fixture();
  try {
    f.store.put(
      "application_autofill",
      "no-slot",
      legacyAutofill({
        id: "no-slot",
        openingId: "one",
        documentSlots: ["resume"],
        openingHash: f.store.opening("one")!.hash,
        url: f.store.opening("one")!.url,
      }),
    );
    assert.throws(
      () => f.manager.start("one", "cover-letter"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 409 &&
        error.message ===
          "This application form has no cover-letter upload slot, so no cover letter is generated.",
    );
    assert.equal(f.store.list("application_preparation").length, 0);
    assert.ok(f.manager.start("one", "resume"));
    // A legacy script and an Opening with no script allow it as before.
    f.store.put(
      "application_autofill",
      "legacy",
      legacyAutofill({ id: "legacy", openingId: "two" }),
    );
    assert.ok(f.manager.start("two", "cover-letter"));
    f.store.put("cache_opening", "bare", {
      ...f.store.opening("one"),
      id: "bare",
    } as Records["cache_opening"]);
    assert.ok(f.manager.start("bare", "cover-letter"));
  } finally {
    await f.cleanup();
  }
});

test("script generation records the form's document slots and attaches only what it has", async () => {
  const f = fixture();
  try {
    const ids = f.docs("docs", "one");
    const api = {
      id: 123,
      title: "Engineer",
      questions: [
        { label: "First Name", fields: [{ name: "first_name" }] },
        { label: "Email", fields: [{ name: "email" }] },
        {
          label: "Resume/CV",
          required: true,
          fields: [{ name: "resume", type: "input_file" }],
        },
      ],
    };
    f.store.put("task", "docs", {
      ...f.store.get("task", "docs"),
      preparationPostingHash: documentPostingHash(api),
    } as Records["task"]);
    const form = (withLetter: boolean) =>
      '<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><div class="file-upload"><div id="upload-label-resume">Resume/CV*</div><label for="resume">Attach</label><input id="resume" type="file"></div>' +
      (withLetter
        ? '<div class="file-upload"><div id="upload-label-cover_letter">Cover Letter</div><label for="cover_letter">Attach</label><input id="cover_letter" type="file"></div>'
        : "") +
      "</form>";
    const generate = (withLetter: boolean, documentIds: string[]) =>
      generateAutofill(
        f.store,
        "one",
        async (url) => ({
          url,
          requestedUrl: url,
          status: 200,
          type: url.includes("boards-api") ? "application/json" : "text/html",
          text: url.includes("boards-api")
            ? JSON.stringify(api)
            : form(withLetter),
          at: new Date().toISOString(),
        }),
        { documentIds, preparationId: "fixture" },
      );
    const noLetter = await generate(false, [ids[0]]);
    assert.deepEqual(noLetter.documentSlots, ["resume"]);
    assert.equal(noLetter.attachments?.length, 1);
    assert.equal(noLetter.attachments?.[0].documentId, ids[0]);
    const both = await generate(true, ids);
    assert.deepEqual(both.documentSlots, ["resume", "cover-letter"]);
    assert.equal(both.attachments?.length, 2);
    assert.deepEqual(
      formDocumentSlots([{ kind: "other" }, { kind: "cover-letter" }]),
      ["cover-letter"],
    );
  } finally {
    await f.cleanup();
  }
});

test("generation counts follow the kinds a run expects", () => {
  const run = (documentKinds?: ApplicationPreparation["documentKinds"]) => [
    {
      id: "r",
      openingId: "one",
      status: "running",
      phase: "answers",
      documentIds: ["resume"],
      documentKinds,
    },
  ];
  assert.deepEqual(openingGenerationCounts(run(["resume"])), { one: 1 });
  assert.deepEqual(openingGenerationCounts(run()), {});
});

test("an active cover-letter task is not adopted by a resume-only run", async () => {
  const f = fixture();
  try {
    scriptWithSlots(f, ["resume"]);
    f.store.put(
      "task",
      "active-letter",
      legacyTask({
        id: "active-letter",
        preset: "posting-cover-letter",
        status: "running",
        context: { openingId: "one" },
      }),
    );
    f.manager.start("one");
    for (let i = 0; i < 5; i++) await f.manager.tick();
    assert.deepEqual(
      f.created.map((id) => f.store.get("task", id)?.preset),
      ["posting-resume"],
    );
    assert.equal(f.manager.latest("one")?.documentTaskId, f.created[0]);
    f.docs(f.created[0], "one", ["resume"]);
    for (let i = 0; i < 6; i++) await f.manager.tick();
    const done = f.manager.latest("one")!;
    assert.equal(done.status, "ready", done.error);
    assert.equal(done.documentIds.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a no-slot script no longer blocks cover-letter regeneration once the Opening moved to another site", async () => {
  const f = fixture();
  try {
    const opening = f.store.opening("one")!;
    f.store.put(
      "application_autofill",
      "no-slot",
      legacyAutofill({
        id: "no-slot",
        openingId: "one",
        documentSlots: ["resume"],
        openingHash: opening.hash,
        url: opening.url,
      }),
    );
    assert.throws(
      () => f.manager.start("one", "cover-letter"),
      /no cover-letter upload slot/,
    );
    // Same URL but changed posting details: the script no longer describes this posting.
    f.store.put("cache_opening", "one", {
      ...opening,
      hash: "edited",
    } as Records["cache_opening"]);
    assert.ok(f.manager.start("one", "cover-letter"));
    f.store.remove("application_preparation", f.manager.latest("one")!.id);
    // The posting moved to an unsupported site: the old form says nothing about the new one.
    f.store.put("cache_opening", "one", {
      ...opening,
      url: "https://example.com/careers/engineer",
      hash: "moved",
    } as Records["cache_opening"]);
    assert.ok(f.manager.start("one", "cover-letter"));
    // A different Greenhouse form (new URL) is likewise not described by the saved script.
    f.store.remove("application_preparation", f.manager.latest("one")!.id);
    f.store.put("cache_opening", "one", {
      ...opening,
      url: "https://job-boards.greenhouse.io/example/jobs/999",
    } as Records["cache_opening"]);
    assert.ok(f.manager.start("one", "cover-letter"));
  } finally {
    await f.cleanup();
  }
});

test("the documents zip packages the run's selection, not every document of an older combined task", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "opening-zip-"));
  const ws = await openFixtureWorkspace(root);
  try {
    ws.store.put("cache_opening", "one", {
      id: "one",
      company_id: "company",
      company: "Example",
      title: "Engineer",
      url: "https://job-boards.greenhouse.io/example/jobs/123",
      hash: "one",
      description: "A fixture role.",
    } as Records["cache_opening"]);
    const ids = ["resume", "cover-letter"].map(
      (kind) =>
        saveFixturePdf(
          ws.store,
          { id: `old-${kind}`, openingId: "one", kind, name: `${kind}.pdf` },
          Buffer.from(`%PDF-1.4\n${kind}`),
        ).id,
    );
    saveCompletedDocumentTask(
      ws.store,
      legacyTask({ id: "old-combined", preset: "posting-application" }),
      "one",
      ids,
      {},
    );
    const names = async () =>
      Object.keys(
        unzipSync(
          new Uint8Array(
            await (await ws.get("/api/openings/one/documents")).arrayBuffer(),
          ),
        ),
      ).sort();
    assert.deepEqual(
      await names(),
      ["cover-letter.pdf", "resume.pdf"],
      "no run: task-based lookup",
    );
    ws.store.put("application_preparation", "run", {
      id: "run",
      openingId: "one",
      applicationId: "app",
      status: "ready",
      phase: "ready",
      message: "",
      createdAt: "2026-11-08T00:00:00Z",
      updatedAt: "2026-11-08T00:00:00Z",
      openingHash: "one",
      documentIds: [ids[0]],
      documentKinds: ["resume"],
      taskIds: [],
      supportedForm: true,
    } as Records["application_preparation"]);
    assert.deepEqual(await names(), ["resume.pdf"]);
  } finally {
    await ws.close();
    rmSync(root, { recursive: true, force: true });
  }
});
