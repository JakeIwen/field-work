import {
  GreenhousePullManager,
  stageGreenhouseDecision,
} from "../app/server/greenhouse-pull.js";
import {
  at,
  card,
  posting,
} from "../app/tests/fixtures/greenhouse-pull-fixture.js";
import { legacyTask } from "../app/tests/fixtures/legacy-records.js";
import { searchUrl } from "../app/server/greenhouse-source.js";
import type { Store } from "../app/server/storage.js";

/** Sixty simulated one-second ticks; source/model fixtures never use the network. */
export async function measurePullCycle(
  store: Store,
  simulation = { ticks: 60, stepMs: 1000, advance: (_ms: number) => {} },
) {
  let clock = at,
    pages = 0,
    creates = 0,
    notifies = 0;
  const manager = new GreenhousePullManager(store, {
    clock: () => clock,
    autoStart: false,
    defaultModel: () => undefined,
    notify() {
      notifies++;
    },
    source: {
      async page(query, page) {
        const start = 10000 + pages++ * 3;
        return {
          query,
          page,
          cards: Array.from({ length: 3 }, (_, i) => card(String(start + i))),
          more: true,
          url: searchUrl(query, page),
          at: new Date(clock).toISOString(),
          status: 200,
        };
      },
      posting: async (c) => posting(c),
      close: async () => {},
    },
    async createResearch(run, candidate) {
      const task = legacyTask({
        id: `cycle-${++creates}`,
        preset: "opening-research",
        status: "handoff",
        importUrl: candidate.card.url,
        greenhousePull: { runId: run.id, candidateId: candidate.id },
      });
      store.put("task", task.id, task);
      return task;
    },
    async startTask(id) {
      const task = store.get("task", id);
      if (!task) throw Error("Fixture task missing");
      store.put("task", id, { ...task, status: "running", threadId: id });
      return task;
    },
  });
  try {
    const run = manager.start(100, "memory-cycle");
    for (let tick = 0; tick < simulation.ticks; tick++) {
      clock = at + tick * simulation.stepMs;
      finishReviews(store, manager, run.id);
      await manager.tick();
      simulation.advance(simulation.stepMs);
    }
    return {
      simulatedSeconds: (simulation.ticks * simulation.stepMs) / 1000,
      notifies,
      pages,
      reviews: creates,
      summary: manager.state(),
    };
  } finally {
    await manager.close();
  }
}

function finishReviews(
  store: Store,
  manager: GreenhousePullManager,
  runId: string,
) {
  // Model fixture settles each review with a source-backed excluded outcome.
  for (const candidate of manager.ledger(runId).candidates) {
    const task = candidate.taskId
      ? store.get("task", candidate.taskId)
      : undefined;
    if (task?.status !== "running" || !candidate.posting) continue;
    stageGreenhouseDecision(
      store,
      task,
      {
        decision: "excluded",
        reason:
          "Fixture role is sales operations rather than software development.",
        softwareAssessment: "Maintains sales reports; no engineering duties.",
        remoteAssessment: "US remote in the official source.",
        fitAssessment: "Not a software development opportunity.",
        sources: [candidate.posting.apiUrl],
      },
      true,
    );
    store.put("task", task.id, {
      ...(store.get("task", task.id) ?? task),
      status: "completed",
    });
  }
}
