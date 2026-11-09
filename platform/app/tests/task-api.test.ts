import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { listenOnEphemeralPort } from "./fixtures/ephemeral-port.js";
import { createWorkspace } from "../server/server.js";

test("task API with explicit protocol fixture: retry, approvals, idempotence, resume and static file containment", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-task-api-"));
  const dataDir = path.join(root, ".local");
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
  const { server, port } = await listenOnEphemeralPort();
  const workspace = await createWorkspace({
    root,
    staticDir: path.join(root, "dist"),
    dataDir,
    port,
    connectAgent: false,
    watch: false,
  });
  server.on("request", workspace.app);
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
  async function post(route: string, body: any = {}) {
    return fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  }
  const events = (workspace.agent as any).options.onEvent;
  let available = false;
  let started = 0;
  let steered = 0;
  let thread: any;
  let requests: any[] = [];
  workspace.agent.status = () =>
    ({
      available,
      connected: available,
      reason: available ? null : "Fixture disconnected",
      threads: thread
        ? [{ id: thread.id, activeTurnId: "turn-fixture", uncertain: false }]
        : [],
      pendingRequests: requests,
    }) as any;
  workspace.agent.connect = async () => workspace.agent.status();
  workspace.agent.start = async (input: any) => {
    started++;
    thread = {
      id: "fixture-owned-thread",
      cwd: input.cwd,
      turns: [{ id: "turn-fixture", status: "inProgress", items: [] }],
    };
    events({
      method: "adapter/threadCreated",
      threadId: thread.id,
      params: { thread },
    });
    events({
      method: "turn/started",
      threadId: thread.id,
      params: { turn: thread.turns[0] },
    });
    const request = {
      requestId: "approval-one",
      id: 1,
      threadId: thread.id,
      method: "item/commandExecution/requestApproval",
      params: { command: "fixture command" },
    };
    requests = [request];
    events({
      method: "adapter/request",
      threadId: thread.id,
      request,
      status: "waiting_approval",
    });
    return {
      threadId: thread.id,
      thread,
      turnId: "turn-fixture",
      turn: thread.turns[0],
    };
  };
  workspace.agent.resume = async () => {
    events({
      method: "adapter/threadResumed",
      threadId: thread.id,
      params: { thread },
    });
    return { thread };
  };
  workspace.agent.read = async () => ({ thread });
  workspace.agent.steer = async () => {
    steered++;
    return { turnId: "turn-fixture" };
  };
  workspace.agent.respond = (id: any) => {
    requests = requests.filter((r) => r.requestId !== id);
    events({
      method: "adapter/requestAnswered",
      threadId: thread.id,
      requestId: id,
    });
    return { answered: true };
  };
  try {
    const build = path.join(root, "dist");
    mkdirSync(build);
    writeFileSync(
      path.join(root, "outside-static.html"),
      "SAFE_FIXTURE_OUTSIDE_BUILD",
    );
    symlinkSync(
      path.join(root, "outside-static.html"),
      path.join(build, "leak.html"),
    );
    assert.equal(
      (await fetch(base + "/leak.html")).status,
      403,
      "A static file symlink cannot leave dist",
    );
    symlinkSync(
      path.join(root, "outside-static.html"),
      path.join(build, "index.html"),
    );
    assert.equal(
      (await fetch(base + "/")).status,
      403,
      "Default root index must receive the same containment check",
    );
    mkdirSync(path.join(build, "nested"));
    symlinkSync(
      path.join(root, "outside-static.html"),
      path.join(build, "nested", "index.html"),
    );
    assert.equal(
      (await fetch(base + "/nested/")).status,
      403,
      "Nested default indexes cannot leave dist",
    );
    rmSync(path.join(build, "index.html"));
    writeFileSync(path.join(build, "index.html"), "<p>Safe built client</p>");
    assert.equal(
      (await fetch(base + "/")).status,
      200,
      "Regular built files remain available",
    );
    const body = {
      preset: "job-fit",
      prompt: "Review this selected evidence only.",
      mode: "live",
      clientRequestId: "create-once",
      context: {},
    };
    let response = await post("/api/tasks", body);
    assert.equal(response.status, 200);
    let task = await response.json();
    assert.equal(task.status, "unavailable");
    assert.equal(started, 0);
    const duplicate = await (await post("/api/tasks", body)).json();
    assert.equal(duplicate.id, task.id);
    assert.equal(workspace.store.list("task").length, 1);
    const draft = path.join(dataDir, "drafts", task.id);
    const originalCopy = readFileSync(
      path.join(draft, "source_data/github_evidence_dossier.md"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "source_data/github_evidence_dossier.md"),
      "# External change after context capture\n",
    );
    available = true;
    response = await post(`/api/tasks/${task.id}/start`);
    assert.equal(response.status, 200);
    task = await response.json();
    assert.equal(started, 1);
    assert.equal(task.status, "waiting for approval");
    await t.test("promotion rejects a task waiting for approval", async () => {
      assert.ok(
        !task.fixture,
        "The fixture guard must not mask the status guard",
      );
      const promotion = await post(`/api/tasks/${task.id}/promote`);
      assert.equal(promotion.status, 409);
      assert.equal(
        (await promotion.json()).error,
        "Finish or interrupt the agent turn before promoting its draft",
      );
    });
    assert.equal(task.threadId, "fixture-owned-thread");
    assert.equal(task.messages[0].delivery, "sent");
    const brotliStateResponse = await fetch(base + "/api/state", {
      headers: { "Accept-Encoding": "gzip, deflate, br, zstd" },
    });
    assert.equal(brotliStateResponse.headers.get("content-encoding"), "br");
    assert.equal(brotliStateResponse.headers.get("vary"), "Accept-Encoding");
    assert.equal(brotliStateResponse.headers.get("cache-control"), "no-store");
    const brotliState = await brotliStateResponse.json();
    const stateResponse = await fetch(base + "/api/state", {
      headers: { "Accept-Encoding": "br;q=0.5, gzip;q=1" },
    });
    assert.equal(stateResponse.headers.get("content-encoding"), "gzip");
    assert.equal(stateResponse.headers.get("vary"), "Accept-Encoding");
    assert.equal(stateResponse.headers.get("cache-control"), "no-store");
    const gzipState = await stateResponse.json();
    const summary = gzipState.tasks.find((t: any) => t.id === task.id);
    assert.equal(summary.events, undefined);
    assert.equal(summary.thread, undefined);
    assert.ok(summary.eventCount > 0);
    assert.deepEqual(summary.pendingRequests, task.pendingRequests);
    const eventResponse = await fetch(base + `/api/tasks/${task.id}/events`);
    assert.deepEqual(
      (await eventResponse.json()).events,
      workspace.store.taskEvents(task.id, { limit: 500 }),
    );
    assert.equal((await fetch(base + "/api/tasks/missing/events")).status, 404);
    const plainState = await fetch(base + "/api/state", {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=0, identity" },
    });
    assert.equal(plainState.headers.get("content-encoding"), null);
    assert.equal(plainState.headers.get("vary"), "Accept-Encoding");
    assert.equal(plainState.headers.get("cache-control"), "no-store");
    const identityState = await plainState.json();
    assert.deepEqual(brotliState, gzipState);
    assert.deepEqual(identityState, gzipState);
    assert.equal(
      (
        await fetch(base + "/api/state", {
          headers: { "Accept-Encoding": "*;q=0, identity;q=0" },
        })
      ).status,
      406,
    );
    assert.equal(
      readFileSync(
        path.join(draft, "source_data/github_evidence_dossier.md"),
        "utf8",
      ),
      originalCopy,
    );
    response = await post(`/api/tasks/${task.id}/start`);
    assert.equal(response.status, 409);
    assert.equal(started, 1);
    const other = await (
      await post("/api/tasks", {
        ...body,
        mode: "handoff",
        clientRequestId: "other",
      })
    ).json();
    response = await post(`/api/tasks/${other.id}/respond`, {
      requestId: "approval-one",
      response: { decision: "accept" },
    });
    assert.equal(response.status, 400);
    response = await post(`/api/tasks/${task.id}/respond`, {
      requestId: "not-this-request",
      response: { decision: "accept" },
    });
    assert.equal(response.status, 403);
    response = await post(`/api/tasks/${task.id}/respond`, {
      requestId: "approval-one",
      response: { decision: "decline" },
    });
    assert.equal(response.status, 200);
    assert.equal(workspace.store.get("task", task.id)!.status, "running");
    response = await post(`/api/tasks/${task.id}/message`, {
      prompt: "An authorized follow-up.",
      clientRequestId: "followup-once",
    });
    assert.equal(response.status, 200);
    assert.equal(steered, 1);
    response = await post(`/api/tasks/${task.id}/message`, {
      prompt: "An authorized follow-up.",
      clientRequestId: "followup-once",
    });
    assert.equal(response.status, 200);
    assert.equal(steered, 1);
    assert.equal((await response.json()).result.duplicate, true);
    events({
      method: "adapter/disconnected",
      threadId: thread.id,
      reason: "Fixture stream process lost.",
    });
    assert.equal(workspace.store.get("task", task.id)!.status, "disconnected");
    response = await post(`/api/tasks/${task.id}/resume`);
    assert.equal(response.status, 200);
    task = (await response.json()).task;
    assert.equal(task.status, "running");
    assert.equal(task.activeTurnId, "turn-fixture");
    assert.equal(started, 1);
  } finally {
    await workspace.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
