import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { draftPath } from "../server/bundles.js";
import { startOpeningApplication } from "../server/opening-workflow.js";
import { sha256 } from "../server/storage.js";
import { createWorkspace } from "../server/server.js";
import {
  questionReferenceId,
  referenceFromThread,
} from "../server/question-context.js";
import { platformRoot } from "../server/paths.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";

type RequestFixture = {
  base: string;
  host: string;
  csrf?: string;
};

function request(
  fixture: RequestFixture,
  route: string,
  method: "GET" | "POST" | "PUT",
  body?: Record<string, unknown>,
) {
  const url = new URL(fixture.base + route);
  const headers: Record<string, string> = { Host: fixture.host };
  if (fixture.csrf) headers["X-CSRF-Token"] = fixture.csrf;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) =>
          chunks.push(Buffer.from(chunk)),
        );
        response.on("error", reject);
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    // Task creation captures a full source bundle; under the parallel suite
    // (deploy checks) it has exceeded 10 s while taking 1-3 s alone.
    req.setTimeout(30000, () =>
      req.destroy(new Error("Fixture request timed out")),
    );
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

async function openFixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "fieldwork-missing-records-"),
  );
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
  for (const file of ["AGENTS.md", "README.md"])
    cpSync(path.join(repositoryRoot, file), path.join(root, file));
  for (const folder of ["client", "shared"])
    cpSync(
      path.join(platformRoot, "app", folder),
      path.join(root, "platform/app", folder),
      { recursive: true },
    );
  for (const file of ["package.json", "tsconfig.json", "index.html"])
    cpSync(path.join(platformRoot, file), path.join(root, "platform", file));
  mkdirSync(path.join(root, "dist"));

  const workspace = await createWorkspace({
    root,
    dataDir: path.join(root, ".local"),
    port: 0,
    staticDir: path.join(root, "dist"),
    connectAgent: false,
    watch: false,
  });
  // Task preparation needs reference context, not a real account's saved thread.
  workspace.store.put(
    "reference_context",
    questionReferenceId,
    referenceFromThread({
      id: questionReferenceId,
      turns: [
        {
          items: [
            { type: "agentMessage", text: "Synthetic writing preferences." },
          ],
        },
      ],
    }),
  );
  const server = workspace.app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server did not bind a TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    // Native HTTP preserves the configured Host independently of the ephemeral
    // listener address; fetch can replace this header with the socket address.
    const host = "127.0.0.1:0";
    const sessionResponse = await request(
      { base, host },
      "/api/session",
      "GET",
    );
    assert.equal(sessionResponse.status, 200);
    const csrf = (await sessionResponse.json()).csrfToken;
    return { root, workspace, server, base, host, csrf };
  } catch (error) {
    await closeFixture({ root, workspace, server });
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;

async function closeFixture({
  root,
  workspace,
  server,
}: Pick<Fixture, "root" | "workspace" | "server">): Promise<void> {
  server.closeAllConnections();
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  } finally {
    try {
      await workspace.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function get(fixture: Fixture, route: string) {
  return request(fixture, route, "GET");
}

function post(
  fixture: Fixture,
  route: string,
  body: Record<string, unknown> = {},
) {
  return request(fixture, route, "POST", body);
}

function put(
  fixture: Fixture,
  route: string,
  body: Record<string, unknown> = {},
) {
  return request(fixture, route, "PUT", body);
}

async function createTask(
  fixture: Fixture,
  preset: string,
  fields: Record<string, unknown> = {},
) {
  const response = await post(fixture, "/api/tasks", {
    preset,
    prompt: "Missing-record route fixture",
    mode: "handoff",
    context: {},
    ...fields,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function assertStatus(response: Response, status: number) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(typeof body.error, "string");
  return body;
}

async function assertError(
  response: Response | Promise<Response>,
  status: number,
  message: string,
) {
  const body = await assertStatus(await response, status);
  assert.equal(body.error, message);
  return body;
}

test("HTTP routes distinguish missing records from missing dependencies", async () => {
  const fixture = await openFixture();
  const { workspace } = fixture;
  try {
    for (const route of [
      "/api/tasks/missing/start",
      "/api/tasks/missing/resume",
      "/api/tasks/missing/message",
      "/api/tasks/missing/interrupt",
    ]) {
      const response = await post(fixture, route, {
        prompt: "Retry this task",
      });
      const body = await assertStatus(response, 404);
      assert.match(body.error, /task missing/i);
    }
    await assertError(
      post(fixture, "/api/tasks/missing/respond", {
        requestId: "missing-approval",
        response: { decision: "accept" },
      }),
      404,
      "Task missing",
    );

    const artifactTask = await createTask(fixture, "resume-revision");
    const artifactBefore = workspace.store.get("task", artifactTask.id);
    const artifactFile = draftPath(
      workspace.store,
      artifactTask.id,
      "README.md",
    );
    const artifactContent = readFileSync(artifactFile, "utf8");
    workspace.store.db
      .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
      .run("bundle", artifactTask.id);
    await assertError(
      post(fixture, `/api/tasks/${artifactTask.id}/artifacts`, {
        documentIds: [],
      }),
      409,
      "The task draft bundle is missing.",
    );
    assert.deepEqual(
      workspace.store.get("task", artifactTask.id),
      artifactBefore,
    );

    await assertError(
      put(fixture, "/api/tasks/missing/artifact", {
        path: "notes.md",
        expectedHash: "",
        content: "Draft note",
      }),
      404,
      "Task missing",
    );
    await assertError(
      put(fixture, `/api/tasks/${artifactTask.id}/artifact`, {
        path: "README.md",
        expectedHash: sha256(artifactContent),
        content: "Draft note",
      }),
      409,
      "Draft bundle missing",
    );
    assert.equal(readFileSync(artifactFile, "utf8"), artifactContent);

    const promotionTask = await createTask(fixture, "resume-revision");
    workspace.store.db
      .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
      .run("bundle", promotionTask.id);
    const body = await assertStatus(
      await post(fixture, `/api/tasks/${promotionTask.id}/promote`),
      409,
    );
    assert.match(body.error, /bundle.*missing/i);

    const greenhouseResponse = await post(
      fixture,
      "/api/greenhouse/pulls/missing/action",
      { action: "pause" },
    );
    const greenhouseBody = await assertStatus(greenhouseResponse, 404);
    assert.match(greenhouseBody.error, /pull not found/i);
    await assertStatus(
      await get(fixture, "/api/greenhouse/pulls/missing/ledger"),
      404,
    );

    const originalImport = workspace.store.import.bind(workspace.store);
    workspace.store.import = (result) => {
      const summary = originalImport(result);
      workspace.store.db
        .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
        .run("meta", "import");
      return summary;
    };
    try {
      const reindexBody = await assertStatus(
        await post(fixture, "/api/reindex"),
        409,
      );
      assert.match(reindexBody.error, /metadata.*missing|missing.*metadata/i);
    } finally {
      workspace.store.import = originalImport;
    }

    const script = "(() => {})();";
    const scriptHash = sha256(script);
    writeFileSync(workspace.store.objectPath(scriptHash), script);
    const existingOpening = workspace.store.openings().at(0);
    assert.ok(existingOpening);
    const openingId = existingOpening.id;
    const scriptId = "existing-opening-script";
    workspace.store.put("application_autofill", scriptId, {
      id: scriptId,
      openingId,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      url: existingOpening.url,
      title: existingOpening.title,
      openingHash: existingOpening.hash,
      sourceHash: "",
      profileHash: "",
      helperHash: "",
      scriptHash,
      evidenceHash: "",
      answers: [],
      review: [],
    });
    startOpeningApplication(workspace.store, openingId);
    const originalOpening = workspace.store.opening;
    let openingLookups = 0;
    workspace.store.opening = (id) => {
      const opening = originalOpening.call(workspace.store, id);
      openingLookups += 1;
      if (openingLookups === 1) {
        workspace.store.db
          .prepare("DELETE FROM records WHERE kind IN (?, ?) AND id = ?")
          .run("cache_opening", "custom_opening", id);
      }
      return opening;
    };
    const applicationsBefore = workspace.store.list("application");
    const journalBefore = workspace.store.list("journal");
    const personalBefore = workspace.store.get("personal", openingId);
    try {
      await assertError(
        post(fixture, `/api/openings/${openingId}/autofill/${scriptId}/copied`),
        404,
        "Opening not found",
      );
      assert.equal(openingLookups, 2);
      assert.equal(workspace.store.opening(openingId), undefined);
      assert.deepEqual(workspace.store.list("application"), applicationsBefore);
      assert.deepEqual(workspace.store.list("journal"), journalBefore);
      assert.deepEqual(
        workspace.store.get("personal", openingId),
        personalBefore,
      );
    } finally {
      workspace.store.opening = originalOpening;
    }
  } finally {
    await closeFixture(fixture);
  }
});

test(
  "render route reports a missing bundle",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixture = await openFixture();
    const { workspace } = fixture;
    try {
      const renderTask = await createTask(fixture, "posting-application", {
        postingText: "Fixture posting text for document rendering.",
        postingUrl: "https://example.invalid/jobs/fixture",
        postingLabel: "Fixture application",
      });
      workspace.store.put("task", renderTask.id, {
        ...renderTask,
        status: "completed",
        documentResult: { status: "ready", turnId: "completed-turn" },
      });
      workspace.store.db
        .prepare("DELETE FROM records WHERE kind = ? AND id = ?")
        .run("bundle", renderTask.id);
      await assertError(
        post(fixture, `/api/tasks/${renderTask.id}/render`),
        409,
        "The task draft bundle is missing. Restore it before generating PDFs.",
      );
    } finally {
      await closeFixture(fixture);
    }
  },
);
