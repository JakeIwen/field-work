import type { GreenhouseEmploymentType } from "../../shared/greenhouse-search.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Store } from "../../server/storage.js";
import {
  GreenhousePullManager,
  stageGreenhouseDecision,
  type PullRun,
  type PullCandidate,
} from "../../server/greenhouse-pull.js";
import { prepareOpeningResearch } from "../../server/opening-workflow.js";
import { creationOptionFields } from "../../server/task-kinds/task-creation-fields.js";
import { applicationEvidencePaths } from "../../server/application-evidence.js";
import { at, card, posting } from "./greenhouse-pull-fixture.js";
import {
  searchUrl,
  type GreenhousePosting,
} from "../../server/greenhouse-source.js";
import type { Task } from "../../shared/task-records.js";

function memoryControls() {
  let clock = at;
  return {
    cards: [card("1")],
    posting: (item: ReturnType<typeof card>): GreenhousePosting | null =>
      posting(item),
    fetches: [] as string[],
    templateSuffix: "",
    setTime: (value: number) => {
      clock = value;
    },
    time: () => clock,
  };
}

function createResearch(
  store: Store,
  controls: ReturnType<typeof memoryControls>,
  run: PullRun,
  candidate: PullCandidate,
) {
  const fields = creationOptionFields({
    greenhouseContext: { run, candidate },
  });
  assert.ok(fields.greenhousePull);
  const task = {
    id: randomUUID(),
    preset: "opening-research",
    status: "handoff",
    importUrl: candidate.card.url,
    prompt: "Review candidate",
    context: {},
    version: 1,
    messages: [],
    events: [],
    posting: {
      url: candidate.card.url,
      text: candidate.posting?.text ?? "",
      fetchedAt: new Date(controls.time()).toISOString(),
    },
    ...fields,
    greenhousePull: {
      ...fields.greenhousePull,
      instructions:
        fields.greenhousePull.instructions + controls.templateSuffix,
    },
  } as Task;
  const prepared = prepareOpeningResearch(store, task);
  return store.put("task", task.id, { ...task, ...prepared });
}

function reviewDependencies(
  store: Store,
  controls: ReturnType<typeof memoryControls>,
) {
  return {
    autoStart: false,
    formCheckRead: async (): Promise<never> => {
      throw new Error("fixture: no network");
    },
    clock: controls.time,
    notify: () => {},
    source: {
      page: async (
        query: string,
        page: number,
        employmentTypes?: GreenhouseEmploymentType[],
      ) => ({
        query,
        page,
        employmentTypes,
        status: 200,
        more: false,
        at: new Date(controls.time()).toISOString(),
        url: searchUrl(query, page, employmentTypes),
        cards: controls.cards,
      }),
      posting: async (item: ReturnType<typeof card>) => {
        controls.fetches.push(item.id);
        return controls.posting(item);
      },
      close: async () => {},
    },
    createResearch: async (run: PullRun, candidate: PullCandidate) =>
      createResearch(store, controls, run, candidate),
    startTask: async (id: string) => {
      const task = store.get("task", id);
      assert.ok(task);
      // Real starts queue the prompt as the first user message (task-start.ts).
      return store.put("task", id, {
        ...task,
        status: "running",
        threadId: id,
        messages: [
          ...(task.messages ?? []),
          {
            id: `${id}:initial`,
            role: "user",
            text: task.prompt,
            at: new Date(controls.time()).toISOString(),
            delivery: "queued",
          },
        ],
      });
    },
  };
}

function finishReview(
  store: Store,
  outcome: "excluded" | "deferred",
  clock: number,
) {
  const task = store.list("task").find((task) => task.status === "running");
  assert.ok(task?.greenhousePull);
  const candidate = store.get(
    "greenhouse_pull_candidate",
    task.greenhousePull.candidateId,
  );
  assert.ok(candidate?.posting);
  stageGreenhouseDecision(
    store,
    task,
    {
      decision: outcome,
      reason: "The official posting excludes US-based employment.",
      softwareAssessment: "The duties require software engineering delivery.",
      remoteAssessment:
        "The employer limits hiring to Europe, excluding US employment.",
      fitAssessment: "Geographic eligibility prevents this application.",
      sources: [candidate.posting.apiUrl],
    },
    true,
  );
  const staged = store.get("task", task.id);
  assert.ok(staged);
  store.put("task", task.id, {
    ...staged,
    status: "completed",
    // Real tasks never record completedAt; their last update is the decision time.
    updatedAt: new Date(clock).toISOString(),
  });
  return candidate;
}

export function memoryFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-memory-"));
  mkdirSync(path.join(root, "source_data"));
  for (const relative of applicationEvidencePaths)
    writeFileSync(
      path.join(root, relative),
      "Evidence-backed software development in the US.",
    );
  const store = new Store(root, path.join(root, ".local/data"));
  const controls = memoryControls();
  const dependencies = reviewDependencies(store, controls);
  let manager = new GreenhousePullManager(store, dependencies);
  const tickUntil = async (ready: () => boolean) => {
    for (let n = 0; n < 80 && !ready(); n++) await manager.tick();
    assert.ok(ready(), JSON.stringify(manager.state()));
  };
  return {
    root,
    store,
    controls,
    tickUntil,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.close();
      manager = new GreenhousePullManager(store, dependencies);
    },
    async running() {
      await tickUntil(() =>
        store.list("task").some((task) => task.status === "running"),
      );
      const task = store.list("task").find((task) => task.status === "running");
      assert.ok(task);
      return task;
    },
    async finish(outcome: "excluded" | "deferred" = "excluded") {
      const candidate = finishReview(store, outcome, controls.time());
      await tickUntil(
        () =>
          store.get("greenhouse_pull_candidate", candidate.id)?.reviewed ===
          true,
      );
      const saved = store.get("greenhouse_pull_candidate", candidate.id);
      assert.ok(saved);
      return saved;
    },
    async exhaust() {
      await tickUntil(() => manager.state()?.status === "exhausted");
    },
    async close() {
      await manager.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
