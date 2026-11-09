import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppState } from "../shared/types.js";
import type {
  PullCandidate,
  PullRun,
} from "../server/greenhouse-pull-records.js";
import { publicationPullCandidate } from "../server/opening-pull/publication.js";
import type { Task } from "../shared/task-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import {
  card,
  posting,
  fixture,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";

function legacyRun(): PullRun {
  return {
    id: "legacy-mixed",
    providers: ["greenhouse", "ashby", "lever"],
    target: 1,
    clientRequestId: "legacy-click",
    status: "target_reached",
    phase:
      "Requested number added. Remaining search results were not exhausted.",
    queryIndex: 0,
    page: 2,
    cutoff: "2026-09-21T20:00:00Z",
    pages: [
      {
        query: "software",
        page: 1,
        ids: ["example:1"],
        more: true,
        at: "2026-09-28T20:00:00Z",
        status: 200,
      },
    ],
    failures: [],
    limitCount: 0,
    createdAt: "2026-09-28T20:00:00Z",
    updatedAt: "2026-09-28T20:01:00Z",
  };
}

function legacyCandidate(
  provider: "ashby" | "lever",
  state: PullCandidate["state"],
): PullCandidate {
  const id =
    provider === "ashby"
      ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const host = provider === "ashby" ? "jobs.ashbyhq.com" : "jobs.lever.co";
  return {
    id: `legacy-mixed:${provider}:global:example:${id}`,
    runId: "legacy-mixed",
    card: {
      ...card(id),
      provider,
      url: `https://${host}/example/${id}`,
      firstPublished: null,
    },
    state,
    ...(state === "added"
      ? { openingId: "legacy-opening", reviewed: true }
      : {}),
    // Legacy source evidence need not pass any retired provider decoder to remain readable.
    posting: {
      ...posting(card(id)),
      provider,
      raw: { id, description: "Saved provider evidence" },
    },
  };
}

async function withWorkspace(
  run: (
    workspace: Awaited<ReturnType<typeof openFixtureWorkspace>>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pull-legacy-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    await run(workspace);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function saveLegacyRecords(
  workspace: Awaited<ReturnType<typeof openFixtureWorkspace>>,
) {
  const { store } = workspace;
  const run = {
    ...legacyRun(),
    providerCursor: 1,
    inventory: {
      boards: [
        {
          provider: "ashby",
          board: "example",
          offset: 0,
          state: "pending",
          pages: [],
        },
      ],
      available: { ashby: 279, lever: 125 },
      rotation: { ashby: 2, lever: 1 },
      capturedAt: "2026-09-28T20:00:00Z",
    },
  };
  store.put("greenhouse_pull_run", run.id, run);
  for (const candidate of [
    legacyCandidate("ashby", "added"),
    legacyCandidate("lever", "discovered"),
  ])
    store.put("greenhouse_pull_candidate", candidate.id, candidate);
  const opening = legacyOpening({
    id: "legacy-opening",
    url: legacyCandidate("ashby", "added").card.url,
    pullSource: {
      provider: "ashby",
      board: "example",
      postingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      region: "global",
      apiUrl: "https://api.ashbyhq.com/posting-api/job-board/example",
      pullId: run.id,
      date: {
        kind: "last-published",
        value: "2026-09-25T12:00:00Z",
        source: "https://api.ashbyhq.com/posting-api/job-board/example",
        fetchedAt: "2026-09-28T20:00:00Z",
      },
    },
  });
  store.put("custom_opening", opening.id, opening);
  return { run, opening };
}

test("state and ledger preserve a finished legacy multi-provider run, candidates and Opening source date", async () => {
  await withWorkspace(async (workspace) => {
    const { run, opening } = saveLegacyRecords(workspace);
    const before = workspace.store.db
      .prepare(
        "SELECT kind, id, json FROM records WHERE kind IN ('greenhouse_pull_run', 'greenhouse_pull_candidate', 'custom_opening') ORDER BY kind, id",
      )
      .all();
    const response = await workspace.get("/api/state");
    assert.equal(response.status, 200);
    const state: AppState = await response.json();
    assert.equal(state.greenhousePull?.status, "target_reached");
    assert.equal(state.greenhousePull?.legacySources, true);
    assert.equal(state.greenhousePull?.added, 1);
    assert.equal(state.greenhousePull?.discovered, 2);
    assert.equal(state.greenhousePull?.pending, 1);
    assert.deepEqual(state.greenhousePull?.addedOpeningIds, [opening.id]);
    assert.equal("providers" in state.greenhousePull!, false);
    assert.equal("inventory" in state.greenhousePull!, false);
    assert.equal("currentProvider" in state.greenhousePull!, false);
    assert.deepEqual(
      state.openings.find((row) => row.id === opening.id)?.pullSource,
      opening.pullSource,
    );
    const ledgerResponse = await workspace.get(
      `/api/greenhouse/pulls/${run.id}/ledger`,
    );
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json();
    assert.deepEqual(ledger.run, { ...run, activity: [] });
    assert.deepEqual(state.greenhousePull?.activity, []);
    assert.deepEqual(
      ledger.candidates,
      workspace.store.list("greenhouse_pull_candidate"),
    );
    assert.deepEqual(
      workspace.store.db
        .prepare(
          "SELECT kind, id, json FROM records WHERE kind IN ('greenhouse_pull_run', 'greenhouse_pull_candidate', 'custom_opening') ORDER BY kind, id",
        )
        .all(),
      before,
    );
  });
});

test("unfinished legacy sources display paused, reject resume and preserve evidence until explicitly stopped", async () => {
  await withWorkspace(async (workspace) => {
    const { run } = saveLegacyRecords(workspace);
    const unfinished = { ...run, status: "paused" as const };
    workspace.store.put("greenhouse_pull_run", run.id, unfinished);
    const state: AppState = await (await workspace.get("/api/state")).json();
    assert.equal(state.greenhousePull?.status, "paused");
    assert.match(state.greenhousePull?.phase ?? "", /retired sources/);
    const resume = await workspace.post(
      `/api/greenhouse/pulls/${run.id}/action`,
      { action: "resume" },
    );
    assert.equal(resume.status, 409);
    assert.match((await resume.json()).error, /no longer supported/);
    assert.deepEqual(
      workspace.store.get("greenhouse_pull_run", run.id),
      unfinished,
    );
    const stop = await workspace.post(
      `/api/greenhouse/pulls/${run.id}/action`,
      { action: "stop" },
    );
    assert.equal(stop.status, 200);
    assert.equal(
      workspace.store.get("greenhouse_pull_run", run.id)?.status,
      "stopped",
    );
    assert.equal(workspace.store.list("greenhouse_pull_candidate").length, 2);
  });
});

test("pull API rejects retired and malformed providers before creating any run", async () => {
  await withWorkspace(async (workspace) => {
    for (const providers of [
      ["ashby"],
      ["lever"],
      ["greenhouse", "ashby", "lever"],
      [],
      ["greenhouse", "greenhouse"],
      "greenhouse",
      null,
    ]) {
      const response = await workspace.post("/api/greenhouse/pulls", {
        target: 1,
        providers,
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /only Greenhouse/);
    }
    assert.equal(workspace.store.list("greenhouse_pull_run").length, 0);
    for (const body of [
      { target: 1 },
      { target: 1, providers: ["greenhouse"] },
    ]) {
      const response = await workspace.post("/api/greenhouse/pulls", body);
      assert.equal(response.status, 200);
      const run = await response.json();
      assert.equal("providers" in run, false);
      assert.equal("inventory" in run, false);
      assert.equal(
        (
          await workspace.post(`/api/greenhouse/pulls/${run.id}/action`, {
            action: "stop",
          })
        ).status,
        200,
      );
    }
  });
});

test("retired candidates cannot publish through the shared Opening publisher guard", async () => {
  const f = fixture();
  try {
    const run = { ...legacyRun(), status: "running" as const };
    const candidate = {
      ...legacyCandidate("ashby", "reviewing"),
      taskId: "legacy-task",
    };
    f.store.put("greenhouse_pull_run", run.id, run);
    f.store.put("greenhouse_pull_candidate", candidate.id, candidate);
    const task = {
      id: candidate.taskId,
      status: "completed",
      greenhousePull: { runId: run.id, candidateId: candidate.id },
      greenhouseDecision: { decision: "add" },
    } as Task;
    assert.throws(
      () => publicationPullCandidate(f.store, task),
      /no longer supported/,
    );
  } finally {
    await f.close();
  }
});

test("new Greenhouse pulls deduplicate saved dismissed and closed openings beside legacy candidates", async () => {
  const f = fixture();
  try {
    f.store.put("greenhouse_pull_run", "legacy-mixed", legacyRun());
    for (const candidate of [
      legacyCandidate("ashby", "added"),
      legacyCandidate("lever", "discovered"),
    ])
      f.store.put("greenhouse_pull_candidate", candidate.id, candidate);
    const closed = legacyOpening({
      id: "saved",
      url: card("1").url,
      postingStatus: "closed",
    });
    f.store.put("custom_opening", closed.id, closed);
    f.store.put("personal", closed.id, {
      version: 1,
      dismissed: true,
      notes: "Keep",
    });
    f.manager.start(1, "greenhouse-only");
    await advanceUntil(f, () => f.manager.state()?.existing === 1);
    assert.equal(f.store.get("personal", closed.id)?.dismissed, true);
    assert.equal(f.store.get("personal", closed.id)?.notes, "Keep");
    assert.equal(
      f.store.get("custom_opening", closed.id)?.postingStatus,
      "closed",
    );
    assert.deepEqual(
      f.store.get("greenhouse_pull_run", "legacy-mixed"),
      legacyRun(),
    );
    assert.deepEqual(
      f.store.get(
        "greenhouse_pull_candidate",
        legacyCandidate("lever", "discovered").id,
      ),
      legacyCandidate("lever", "discovered"),
    );
  } finally {
    await f.close();
  }
});
