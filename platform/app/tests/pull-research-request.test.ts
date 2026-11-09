import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pullResearchRequest } from "../server/greenhouse-research.js";
import { type PullCard } from "../server/opening-pull/contract.js";
import type { PullCandidate } from "../server/greenhouse-pull-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function candidate(card: PullCard): PullCandidate {
  const runId = randomUUID();
  return {
    id: `${runId}:${card.board}:${card.id}`,
    runId,
    card,
    state: "discovered",
  };
}

test("task creation accepts Greenhouse pull review requests", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pull-research-request-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    {
      const id = "123456789",
        board = "example-company";
      const request = pullResearchRequest(
        candidate({
          id,
          board,
          company: board,
          title: "Senior Software Engineer",
          url: `https://job-boards.greenhouse.io/${board}/jobs/${id}`,
          firstPublished: null,
        }),
      );
      const response = await workspace.post("/api/tasks", request);
      assert.equal(response.status, 200, await response.clone().text());
      const task = await response.json();
      assert.equal(task.clientRequestId, request.clientRequestId);
      const repeat = await (await workspace.post("/api/tasks", request)).json();
      assert.equal(repeat.id, task.id, "a retried creation reuses the task");
    }
    const tooLong = await workspace.post("/api/tasks", {
      preset: "opening-research",
      prompt: "Review",
      clientRequestId: "x".repeat(301),
    });
    assert.equal(tooLong.status, 400);
    assert.match(
      (await tooLong.json()).error,
      /Text is 301 characters; the limit is 300/,
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
