import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import { legacyApplication } from "./fixtures/legacy-records.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { unzipSync } from "fflate";
import { listenOnEphemeralPort } from "./fixtures/ephemeral-port.js";
import { createWorkspace } from "../server/server.js";
import { Store } from "../server/storage.js";

test("sample workspace API: persistence, immutable submission, safe previews, CSRF and external refresh", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "job-workspace-api-"));
  for (const folder of [
    "company_careers",
    "source_data",
    "source_master_template",
    "employer_specific",
    "old_resume",
  ])
    cpSync(path.join(repositoryRoot, folder), path.join(root, folder), {
      recursive: true,
    });
  cpSync(path.join(repositoryRoot, "AGENTS.md"), path.join(root, "AGENTS.md"));
  cpSync(path.join(repositoryRoot, "README.md"), path.join(root, "README.md"));
  const { server: initialServer, port: initialPort } =
    await listenOnEphemeralPort();
  let server = initialServer;
  let port = initialPort;
  const dataDir = path.join(root, ".local");
  let workspace = await createWorkspace({
    root,
    dataDir,
    port,
    connectAgent: false,
    watch: true,
  });
  server.on("request", workspace.app);
  let base = `http://127.0.0.1:${port}`;
  let csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
  async function request(
    route: string,
    body?: any,
    method = "POST",
    headers: any = {},
  ) {
    return fetch(base + route, {
      method: body === undefined ? "GET" : method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    const original = await (await request("/api/state")).json();
    assert.ok(original.companies.length > 0);
    assert.ok(original.openings.length > 0);
    assert.ok(original.scan.seenCount > original.openings.length);
    assert.ok(original.scan.failedCompanies.length > 0);
    assert.equal(original.applications.length, 0);
    const namedSource = original.documents.find(
      (d: any) => d.format === "pdf" && d.privacy === "public",
    );
    workspace.store.put("generated_document", "download-naming-fixture", {
      ...namedSource,
      id: "download-naming-fixture",
      origin: "generated",
      name: "2026-09-11_Engineer-at-Acme_resume_public_revision.pdf",
      path: ".local/2026-09-11T12-00-00Z_Job-Application-for-Engineer.pdf",
    });
    const namedDownload = await request(
      "/api/documents/download-naming-fixture/download",
    );
    assert.ok(
      namedDownload.headers
        .get("content-disposition")
        ?.includes("2026-09-11_Engineer-at-Acme_resume_public_revision.pdf"),
    );
    assert.deepEqual(
      Buffer.from(await namedDownload.arrayBuffer()),
      readFileSync(workspace.store.objectPath(namedSource.hash)),
    );
    const role = original.openings[0];
    workspace.store.put(
      "application",
      "empty-package-fixture",
      legacyApplication({
        id: "empty-package-fixture",
        openingId: role.id,
        version: 1,
        status: "applied",
        submittedAt: "2026-09-20T12:00:00Z",
        documentIds: [namedSource.id],
        packages: [{ id: "empty", documents: [] }],
      }),
    );
    const emptyExport = await request(
      "/api/applications/empty-package-fixture/export",
    );
    assert.equal(emptyExport.status, 409);
    assert.match((await emptyExport.json()).error, /No documents were saved/);
    workspace.store.db
      .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
      .run("application", "empty-package-fixture");
    const key = encodeURIComponent(role.id);
    let response = await request("/api/personal/" + key, {
      expectedVersion: 0,
      saved: true,
      nextAction: "Ask about pager frequency",
      followUp: "2026-09-07",
    });
    assert.equal(response.status, 200);
    response = await request("/api/personal/" + key, {
      expectedVersion: 0,
      notes: "stale overwrite",
    });
    assert.equal(response.status, 409);
    const progressStream = await fetch(base + "/api/events", {
      signal: AbortSignal.timeout(30000),
    });
    const reader = progressStream.body!.getReader();
    const observedProgress = (async () => {
      const events: any[] = [];
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done)
            throw Error("Progress stream ended before completion");
          pending += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (!block.startsWith("data: ")) continue;
            const event = JSON.parse(block.slice(6));
            if (event.type !== "reindex-progress") continue;
            events.push(event.progress);
            if (event.progress === null) return events;
          }
        }
      } finally {
        await reader.cancel();
      }
    })();
    response = await request("/api/reindex", {});
    assert.equal(response.status, 200);
    const reindexed = await response.json();
    assert.ok(reindexed.summary);
    assert.equal(reindexed.summary.documents.added, 0);
    assert.equal(reindexed.summary.documents.updated, 0);
    const progress = await observedProgress;
    assert.equal(progress[0].phase, "research");
    assert.ok(
      progress.some((p) => p?.phase === "documents" && p.completed === p.total),
    );
    assert.equal(progress.at(-2).phase, "saving");
    assert.equal(progress.at(-1), null);
    let state = await (await request("/api/state")).json();
    assert.equal(state.indexing, false);
    assert.equal(state.reindexProgress, null);
    assert.equal(
      state.personal[role.id].nextAction,
      "Ask about pager frequency",
    );
    assert.equal(state.openings.length, original.openings.length);
    const companySource = path.join(root, "company_careers/companies.md");
    const sourceHash = state.sourceHashes["company_careers/companies.md"];
    writeFileSync(
      companySource,
      readFileSync(companySource, "utf8") +
        "\n<!-- External editor verification fixture -->\n",
    );
    const until = Date.now() + 6000;
    do {
      await new Promise((r) => setTimeout(r, 150));
      state = await (await request("/api/state")).json();
    } while (
      state.sourceHashes["company_careers/companies.md"] === sourceHash &&
      Date.now() < until
    );
    assert.notEqual(
      state.sourceHashes["company_careers/companies.md"],
      sourceHash,
      "File watcher must import an external source edit",
    );
    assert.equal(
      state.personal[role.id].nextAction,
      "Ask about pager frequency",
    );
    response = await request(
      "/api/personal/" + key,
      { expectedVersion: 1, notes: "attack" },
      "POST",
      { Origin: "https://attacker.invalid" },
    );
    assert.equal(response.status, 403);
    response = await fetch(base + "/api/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
    const badHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const r = httpRequest(
          base + "/api/state",
          { headers: { Host: "attacker.invalid" } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        );
        r.on("error", reject);
        r.end();
      },
    );
    assert.equal(badHostStatus, 403);
    response = await request(
      "/api/source?path=" + encodeURIComponent("../AGENTS.md"),
    );
    assert.equal(response.status, 400);
    response = await request(
      "/api/source?path=" +
        encodeURIComponent("source_data/sample_offer_letter.pdf"),
    );
    assert.equal(response.status, 403);
    writeFileSync(path.join(root, "secret.txt"), "not public");
    symlinkSync(
      path.join(root, "secret.txt"),
      path.join(root, "source_data/outside.txt"),
    );
    response = await request("/api/source?path=source_data/outside.txt");
    assert.equal(response.status, 403);
    response = await request("/api/shell", { command: "pwd" });
    assert.equal(response.status, 404);
    const docs = state.documents.filter(
      (d: any) =>
        d.scope === "general" && d.status === "current" && d.format === "pdf",
    );
    assert.ok(docs.length >= 2);
    assert.ok(docs.some((d: any) => d.privacy === "private"));
    assert.ok(docs.some((d: any) => d.privacy === "public"));
    const old = state.documents.find(
      (d: any) =>
        d.scope === "general" &&
        d.status === "superseded" &&
        d.format === "html" &&
        d.privacy === "private",
    );
    const current = state.documents.find(
      (d: any) =>
        d.scope === "general" &&
        d.status === "current" &&
        d.format === "html" &&
        d.privacy === "private",
    );
    response = await request(
      `/api/documents/compare?a=${encodeURIComponent(old.id)}&b=${encodeURIComponent(current.id)}`,
    );
    assert.ok(
      (await response.json()).changes.some((c: any) => c.added || c.removed),
    );
    response = await request(
      `/api/documents/${encodeURIComponent(current.id)}/file`,
    );
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    assert.doesNotMatch(await response.text(), /<script/i);
    response = await request(
      `/api/documents/${encodeURIComponent(docs[0].id)}/file`,
    );
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/pdf/,
    );
    assert.equal(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
    let application = await (
      await request("/api/applications", { openingId: role.id })
    ).json();
    assert.equal(application.status, "considering");
    assert.equal(application.submittedAt, undefined);
    response = await request(
      "/api/applications/" + application.id,
      { expectedVersion: 1, status: "applied" },
      "PATCH",
    );
    assert.equal(response.status, 400);
    application = await (
      await request(
        "/api/applications/" + application.id,
        {
          expectedVersion: 1,
          status: "ready",
          documentIds: [docs[0].id],
          nextAction: "Review before sending",
          notes: "PRIVATE_FIXTURE_NOTES",
          contacts: "PRIVATE_FIXTURE_CONTACT",
        },
        "PATCH",
      )
    ).json();
    assert.equal(application.status, "ready");
    // This is an isolated fixture application, not a claim about Sam's real applications.
    application = await (
      await request(`/api/applications/${application.id}/submit`, {
        expectedVersion: application.version,
        documentIds: [docs[0].id],
      })
    ).json();
    assert.equal(application.status, "applied");
    assert.ok(application.submittedAt.endsWith("Z"));
    assert.equal(
      (await (await request("/api/state")).json()).documents.find(
        (d: any) => d.id === docs[0].id,
      ).usedInApplications[0].id,
      application.id,
    );
    const submittedBytes = readFileSync(path.join(root, docs[0].path));
    writeFileSync(
      path.join(root, docs[0].path),
      Buffer.concat([submittedBytes, Buffer.from("\n% fixture external edit")]),
    );
    await request("/api/reindex", {});
    response = await request(`/api/applications/${application.id}/export`);
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const entry = Object.keys(zip).find((k) => k.endsWith(".pdf"))!;
    assert.deepEqual(Buffer.from(zip[entry]), submittedBytes);
    assert.doesNotMatch(
      Buffer.from(zip["manifest.json"]).toString(),
      /PRIVATE_FIXTURE/,
      "Application packages must exclude private notes and contacts",
    );
    // A truncated source does not remove prior valid research or imply closure.
    writeFileSync(
      path.join(root, "company_careers/current_openings.md"),
      "# partial write",
    );
    await request("/api/reindex", {});
    state = await (await request("/api/state")).json();
    assert.equal(state.openings.length, original.openings.length);
    assert.ok(state.health.some((h: any) => h.severity === "error"));
    assert.deepEqual(
      state.openings
        .filter((o: any) => o.postingStatus === "closed")
        .map((o: any) => o.id)
        .sort(),
      original.openings
        .filter((o: any) => o.postingStatus === "closed")
        .map((o: any) => o.id)
        .sort(),
      "A failed import must not infer additional closures",
    );
    await workspace.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const next = await listenOnEphemeralPort();
    server = next.server;
    port = next.port;
    workspace = await createWorkspace({
      root,
      dataDir,
      port,
      connectAgent: false,
      watch: false,
    });
    server.on("request", workspace.app);
    base = `http://127.0.0.1:${port}`;
    csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
    state = await (await request("/api/state")).json();
    assert.equal(state.personal[role.id].saved, true);
    assert.equal(state.personal[role.id].followUp, "2026-09-07");
    assert.equal(
      state.applications[0].packages[0].documents[0].hash,
      docs[0].hash,
    );
    response = await request("/api/settings", { timezone: "Pacific/Honolulu" });
    assert.equal(response.status, 200);
    assert.equal(
      (await (await request("/api/state")).json()).settings.timezone,
      "Pacific/Honolulu",
    );
    response = await request("/api/settings", { timezone: "Bogus/Zone" });
    assert.equal(response.status, 400);
    response = await request("/api/backup");
    const backup = unzipSync(new Uint8Array(await response.arrayBuffer()));
    assert.ok(backup["workspace.sqlite"]);
    assert.ok(backup["personal-export.json"]);
    const restoredDir = path.join(root, ".restored");
    mkdirSync(restoredDir);
    for (const [relative, bytes] of Object.entries(backup)) {
      const destination = path.join(restoredDir, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    const restored = new Store(root, restoredDir);
    try {
      assert.equal(
        restored.get("personal", role.id)!.nextAction,
        "Ask about pager frequency",
      );
      assert.equal(
        restored.get("application", application.id)!.packages![0].documents[0]
          .hash,
        docs[0].hash,
      );
      assert.deepEqual(
        readFileSync(restored.objectPath(docs[0].hash)),
        submittedBytes,
      );
    } finally {
      restored.close();
    }
  } finally {
    await workspace.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
