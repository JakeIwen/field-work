import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { draftPath } from "../server/bundles.js";
import type {
  PullCandidate,
  PullRun,
} from "../server/greenhouse-pull-records.js";
import { pullResearchRequest } from "../server/greenhouse-research.js";
import { captureGreenhousePolicy } from "../server/opening-pull/policy.js";
import { defaultGreenhousePullPolicy } from "../shared/greenhouse-policy.js";
import { captureGreenhouseGuidance } from "../server/opening-pull/guidance.js";
import { createRegisteredTask } from "../server/task-kinds/registry.js";
import {
  greenhouseReviewPromptPath,
  type GreenhouseReviewPrompt,
} from "../shared/greenhouse-review-prompt.js";
import type { Task } from "../shared/task-records.js";
import { card, posting, at } from "./fixtures/greenhouse-pull-fixture.js";
import { messageModelWorkspace } from "./fixtures/message-model-workspace.js";
import { legacyDocument } from "./fixtures/legacy-records.js";

function section(preview: GreenhouseReviewPrompt, title: string) {
  const found = preview.sections.find((section) => section.title === title);
  assert.ok(found, `Missing section: ${title}`);
  return found.text;
}

async function createReview(
  f: Awaited<ReturnType<typeof messageModelWorkspace>>,
) {
  const run: PullRun = {
    id: "fixture-pull",
    target: 1,
    clientRequestId: "fixture",
    status: "paused",
    phase: "Fixture",
    queryIndex: 0,
    page: 1,
    cutoff: new Date(at - 7 * 86400000).toISOString(),
    limitCount: 0,
    pages: [],
    failures: [],
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
    guidance: captureGreenhouseGuidance(f.store),
    policy: captureGreenhousePolicy(
      f.store.settings(),
      new Date(at).toISOString(),
    ),
  };
  const candidate: PullCandidate = {
    id: "fixture-candidate",
    runId: run.id,
    card: card("123"),
    state: "discovered",
    posting: posting(card("123")),
  };
  f.store.put("greenhouse_pull_run", run.id, run);
  f.store.put("greenhouse_pull_candidate", candidate.id, candidate);
  f.store.put(
    "cache_document",
    "fixture-resume",
    legacyDocument({
      id: "fixture-resume",
      kind: "resume",
      scope: "general",
      status: "current",
      text: "Synthetic resume evidence: JavaScript and TypeScript.",
    }),
  );
  // Same registered creation entry and internal options as WorkspaceRuntime's pull manager.
  const task = await createRegisteredTask(
    {
      store: f.store,
      string: (value) => {
        assert.equal(typeof value, "string");
        return String(value);
      },
      pick: () => ({}),
      documents: () => [],
      questionReference: async () => {
        throw Error("Research must not load question reference");
      },
      suppliedPosting: async () => {
        throw Error("Research must use the captured posting");
      },
      publish: () => {},
      startSavedTask: async () => {
        throw Error("Pull tasks start after bundle capture");
      },
    },
    pullResearchRequest(candidate),
    { greenhouseContext: { run, candidate } },
  );
  assert.ok(task);
  return { task, candidate };
}

function assertCapturedFiles(
  f: Awaited<ReturnType<typeof messageModelWorkspace>>,
  task: Task,
  preview: GreenhouseReviewPrompt,
) {
  for (const [title, file] of [
    [
      "Review instructions · HARVEST-INSTRUCTIONS.md",
      "HARVEST-INSTRUCTIONS.md",
    ],
    [
      "Research instructions · RESEARCH-INSTRUCTIONS.md",
      "RESEARCH-INSTRUCTIONS.md",
    ],
  ])
    assert.equal(
      section(preview, title),
      readFileSync(draftPath(f.store, task.id, file), "utf8"),
    );
  assert.ok(task.manifest?.paths.includes("resume-context.txt"));
  assert.ok(task.manifest?.paths.includes("github-evidence.md"));
  assert.ok(task.manifest?.paths.includes("greenhouse-review-inputs.json"));
  const inventory = section(preview, "Captured files · read on demand");
  for (const file of [
    "context-manifest.json",
    ...(task.manifest?.paths ?? []),
  ]) {
    assert.ok(
      inventory.includes(file),
      `Preview must account for captured file ${file}`,
    );
  }
}

test("read-only preview equals actual review bundle and first-turn protocol inputs, apart from candidate placeholders", async () => {
  const f = await messageModelWorkspace();
  try {
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhousePolicy: {
        ...defaultGreenhousePullPolicy,
        travelCapPercent: 20,
        excludeMissingLanguage: false,
      },
      greenhouseGuidance: {
        employmentScope: ["full_time", "contract"],
        instructions: "Avoid gambling companies.\nVerify working hours.",
        searchTerms: ["fractional"],
      },
      fitCriteria: {
        ...old.fitCriteria,
        technologyExcludeTerms: ["C#", ".NET", "COBOL"],
      },
    });
    const { task, candidate } = await createReview(f);
    const before = f.store.personalExport().records;
    const messagesBefore = f.codex.messages.length;
    const response = await f.get(greenhouseReviewPromptPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const preview: GreenhouseReviewPrompt = await response.json();
    assert.deepEqual(
      f.store.personalExport().records,
      before,
      "Preview cannot mutate tasks, runs, settings or history",
    );
    assert.equal(
      f.codex.messages.length,
      messagesBefore,
      "Preview cannot contact the model",
    );
    assertCapturedFiles(f, task, preview);
    const started = await f.post(`/api/tasks/${task.id}/start`);
    assert.equal(started.status, 200, await started.clone().text());
    const running: Task = await started.json();
    assert.ok(running.threadId, running.error ?? "No review thread started");
    const thread = f.codex.messages.find(
      (message) => message.method === "thread/start",
    );
    const turn = f.codex.messages.find(
      (message) => message.method === "turn/start",
    );
    assert.ok(thread);
    assert.ok(turn);
    assert.equal(
      section(preview, "Model instructions"),
      thread.params.developerInstructions,
    );
    assert.deepEqual(
      JSON.parse(section(preview, "Fieldwork tools")),
      thread.params.dynamicTools,
    );
    assert.deepEqual(turn.params.input, [
      {
        type: "text",
        text: section(preview, "First user message").replaceAll(
          "[POSTING_URL]",
          candidate.card.url,
        ),
      },
    ]);
    assert.equal(
      section(preview, "Saved task request · not the first model message")
        .replaceAll("[COMPANY]", candidate.card.company)
        .replaceAll("[ROLE_TITLE]", candidate.card.title),
      task.prompt,
    );
    assert.notEqual(task.prompt, turn.params.input[0].text);
    await f.complete(
      running,
      "Fixture review input captured; no decision saved.",
    );
  } finally {
    await f.close();
  }
});

test("reopening the preview follows saved scope and exclusions without rewriting captured review instructions", async () => {
  const f = await messageModelWorkspace();
  try {
    const first: GreenhouseReviewPrompt = await (
      await f.get(greenhouseReviewPromptPath)
    ).json();
    assert.match(
      section(first, "Review instructions · HARVEST-INSTRUCTIONS.md"),
      /Scope: Full time/,
    );
    const { task } = await createReview(f);
    const captured = readFileSync(
      draftPath(f.store, task.id, "HARVEST-INSTRUCTIONS.md"),
      "utf8",
    );
    const old = f.store.settings();
    f.store.put("settings", "main", {
      ...old,
      greenhouseGuidance: {
        employmentScope: ["part_time"],
        instructions: "Only education products.",
        searchTerms: [],
      },
      fitCriteria: {
        ...old.fitCriteria,
        technologyExcludeTerms: ["C#", ".NET", "Java"],
      },
    });
    const second: GreenhouseReviewPrompt = await (
      await f.get(greenhouseReviewPromptPath)
    ).json();
    const harvest = section(
      second,
      "Review instructions · HARVEST-INSTRUCTIONS.md",
    );
    assert.match(harvest, /Scope: Part time/);
    assert.match(harvest, /Only education products\./);
    assert.doesNotMatch(harvest, /Scope: Full time/);
    assert.match(
      section(second, "Research instructions · RESEARCH-INSTRUCTIONS.md"),
      /C#, \.NET, Java/,
    );
    assert.equal(
      readFileSync(
        draftPath(f.store, task.id, "HARVEST-INSTRUCTIONS.md"),
        "utf8",
      ),
      captured,
    );
    assert.deepEqual(f.codex.messages, [], "Neither preview starts the agent");
  } finally {
    await f.close();
  }
});
