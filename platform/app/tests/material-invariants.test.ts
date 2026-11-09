import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { atomicWrite, type Store } from "../server/storage.js";
import { createWorkspace } from "../server/server.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import {
  generateAutofill,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import {
  materialAnswerFixture,
  materialBytes,
  saveMaterialPdfs,
} from "./fixtures/material-records.js";
import { backupMaterialFixture } from "./fixtures/backup-materials.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { source } from "./fixtures/application-answers-fixture.js";

function preparationHarness(
  store: Store,
  f: ReturnType<typeof materialAnswerFixture>,
  fail = false,
) {
  let scripts = 0,
    created = 0;
  const manager = new ApplicationPreparationManager(store, {
    changed() {},
    generateScript: (id, documentIds, preparationId) => {
      scripts++;
      if (fail && scripts === 2)
        throw new Error("Injected answer form refresh failure");
      return generateAutofill(store, id, f.read, {
        documentIds,
        preparationId,
      });
    },
    createDocuments: async () => {
      created++;
      assert.fail("No new document task should be needed");
    },
    startTask: async () => {
      assert.fail("No document turn should start");
    },
    startAnswers: async () => null,
  });
  return { manager, created: () => created };
}

for (const reopen of [false, true]) {
  test(`G4: retry after answer/form failure reuses exact PDFs${reopen ? " after workspace reopen" : ""}`, async () => {
    const f = materialAnswerFixture();
    const ids = saveMaterialPdfs(f.store, "original", f.api);
    const before = materialBytes(f.store, ids);
    const originalTaskIds = f.store.list("task").map((t) => t.id);
    let store = f.store;
    let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
    let harness = preparationHarness(store, f, true);
    try {
      harness.manager.start("one");
      for (let i = 0; i < 6; i++) await harness.manager.tick();
      assert.equal(harness.manager.latest("one")?.status, "failed");
      assert.equal(harness.manager.latest("one")?.phase, "answers");
      assert.match(
        harness.manager.latest("one")?.error ?? "",
        /Injected answer form refresh failure/,
      );
      assert.deepEqual(harness.manager.latest("one")?.documentIds, ids);
      assert.deepEqual(materialBytes(store, ids), before);
      assert.equal(harness.created(), 0);
      await harness.manager.close();
      if (reopen) {
        store.close();
        workspace = await createWorkspace({
          root: f.root,
          dataDir: store.dataDir,
          port: 0,
          watch: false,
          connectAgent: false,
        });
        store = workspace.store;
      }
      harness = preparationHarness(store, f);
      harness.manager.start("one");
      for (let i = 0; i < 8; i++) await harness.manager.tick();
      assert.equal(
        harness.manager.latest("one")?.status,
        "ready",
        harness.manager.latest("one")?.error,
      );
      assert.deepEqual(harness.manager.latest("one")?.documentIds, ids);
      assert.deepEqual(materialBytes(store, ids), before);
      assert.equal(harness.created(), 0);
      assert.deepEqual(
        store.list("task").map((t) => t.id),
        originalTaskIds,
      );
    } finally {
      await harness.manager.close();
      if (workspace) await workspace.close();
      else store.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

async function assertSubmittedExports(
  workspace: Awaited<ReturnType<typeof openFixtureWorkspace>>,
  f: Awaited<ReturnType<typeof backupMaterialFixture>>,
  originalScript: string,
  before: ReturnType<typeof materialBytes>,
) {
  const script = await workspace.get(
    `/api/openings/one/autofill/${f.script.id}?download=1`,
  );
  assert.equal(script.status, 200);
  assert.equal(await script.text(), originalScript);
  const response = await workspace.get(
    `/api/applications/${f.application.id}/export`,
  );
  assert.equal(response.status, 200);
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString());
  assert.deepEqual(
    manifest.package.documents.map((d: { id: string; hash: string }) => ({
      id: d.id,
      hash: d.hash,
    })),
    before.map(({ id, hash }) => ({ id, hash })),
  );
  for (const doc of before)
    assert.ok(
      Object.values(zip).some((bytes) => Buffer.from(bytes).equals(doc.bytes)),
    );
}

test("G6: copied script and submitted package remain exportable after revisions, evidence changes and reopen", async () => {
  const f = await backupMaterialFixture();
  const before = materialBytes(f.store, f.ids);
  const originalScript = savedAutofillScript(
    f.store,
    "one",
    f.script.id,
  ).script;
  assert.equal(f.application.submissionSource, "autofill-copy");
  assert.equal(f.application.packages?.[0].scriptId, f.script.id);
  f.store.close();
  let workspace = await openFixtureWorkspace(f.root);
  try {
    const copy = await workspace.post(
      `/api/openings/one/autofill/${f.script.id}/copied`,
    );
    assert.equal(copy.status, 200);
    atomicWrite(
      path.join(f.root, source),
      "Changed synthetic factual evidence",
    );
    const revision = saveMaterialPdfs(workspace.store, "revision", f.api);
    const next = await generateAutofill(workspace.store, "one", f.read, {
      documentIds: revision,
    });
    assert.notEqual(next.id, f.script.id);
    assert.notEqual(next.scriptHash, f.script.scriptHash);
    assert.notDeepEqual(materialBytes(workspace.store, revision), before);
    const recopy = await workspace.post(
      `/api/openings/one/autofill/${next.id}/copied`,
    );
    assert.equal(recopy.status, 200);
    assert.deepEqual(
      workspace.store.get("application", f.application.id)?.packages,
      f.application.packages,
    );
    assert.deepEqual(materialBytes(workspace.store, f.ids), before);
    await assertSubmittedExports(workspace, f, originalScript, before);
    await workspace.close();
    workspace = await openFixtureWorkspace(f.root);
    assert.deepEqual(
      workspace.store.get("application", f.application.id)?.packages,
      f.application.packages,
    );
    assert.deepEqual(materialBytes(workspace.store, f.ids), before);
    await assertSubmittedExports(workspace, f, originalScript, before);
  } finally {
    await workspace.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
