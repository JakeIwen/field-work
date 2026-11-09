import test from "node:test";
import assert from "node:assert/strict";
import { CodexModelCatalog } from "../server/codex-model-catalog.js";
import {
  hideSupersededModels,
  modelRequestGroups,
  modelRequestTypes,
  taskModelRequestType,
  type CodexModel,
  type ModelRequestType,
} from "../shared/codex-models.js";
import { fixture } from "./fixtures/codex-fixture.js";

const model = (id: string, isDefault = false): CodexModel => ({
  id,
  model: id,
  displayName: id,
  isDefault,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
});

test("catalog pagination, cached background loads, concurrent refresh and stale error recovery", async () => {
  let calls = 0;
  let failing = false;
  const catalog = new CodexModelCatalog(async (cursor) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failing) throw new Error("offline");
    return cursor
      ? { data: [model("second")], nextCursor: null }
      : { data: [model("first", true)], nextCursor: "next" };
  });
  const first = catalog.refresh();
  assert.equal(catalog.status().refreshing, true);
  assert.deepEqual(catalog.status().models, []);
  await Promise.all([first, catalog.refresh(), catalog.refresh(true)]);
  assert.equal(calls, 2);
  assert.equal(catalog.status().refreshing, false);
  assert.deepEqual(catalog.resolve("second"), {
    model: "second",
    effort: "high",
  });
  await catalog.refresh();
  assert.equal(calls, 2);
  failing = true;
  await assert.rejects(catalog.refresh(true), /offline/);
  assert.equal(catalog.status().models.length, 2);
  assert.ok(catalog.status().error);
  assert.throws(() => catalog.resolve("second"), /Could not refresh/);
  await catalog.refresh();
  assert.equal(calls, 3, "background failures have a retry cooldown");
  failing = false;
  await catalog.refresh(true);
  assert.equal(catalog.status().error, null);
  assert.equal(catalog.resolve().model, "first");
});

test("incomplete and malformed catalogs cannot replace the last complete list", async () => {
  for (const page of [
    { data: [model("first", true)], nextCursor: "repeated" },
    { data: [{ id: "malformed" }] },
    { data: [] },
    { data: [model("duplicate"), model("duplicate")] },
  ]) {
    const catalog = new CodexModelCatalog(async () => page);
    await assert.rejects(catalog.refresh());
    assert.equal(catalog.available, false);
    assert.throws(() => catalog.resolve());
  }
});

test("every request type uses its configured model and high effort", async () => {
  for (const requestType of modelRequestTypes) {
    const f = fixture({
      modelPreference: (type) =>
        type === requestType ? "gpt-6-sol" : undefined,
    });
    try {
      await f.adapter.start({
        cwd: f.draft,
        prompt: "fixture only",
        requestType,
      });
      const request = f.messages.find((m) => m.method === "thread/start");
      assert.equal(request.params.model, "gpt-6-sol", requestType);
      assert.equal(request.params.config.model_reasoning_effort, "high");
      assert.equal(
        f.messages.find((m) => m.method === "turn/start").params.model,
        "gpt-6-sol",
      );
    } finally {
      f.cleanup();
    }
  }
});

test("saved choices survive reconnect and only switch after an active turn finishes", async () => {
  let chosen = "gpt-6-sol";
  const f = fixture({ modelPreference: () => chosen });
  let resumed: ReturnType<typeof f.create> | undefined;
  try {
    const start = await f.adapter.start({
      cwd: f.draft,
      prompt: "fixture",
      requestType: "questions",
    });
    chosen = "gpt-6-astra";
    await f.adapter.connect(true);
    await f.adapter.resume(start.threadId);
    assert.equal(f.adapter.status().threads[0].model, "gpt-6-sol");
    await f.adapter.interrupt(start.threadId);
    await f.adapter.close();
    resumed = f.create();
    await resumed.connect();
    await resumed.send(start.threadId, "follow-up fixture");
    assert.equal(
      f.messages.filter((m) => m.method === "turn/start").at(-1).params.model,
      "gpt-6-astra",
    );
  } finally {
    await resumed?.close();
    f.cleanup();
  }
});

test("explicit models work without a catalog default and missing saved choices never fall back", async () => {
  for (const choice of ["gpt-6-sol", "removed-model"]) {
    const f = fixture({ defaultModel: null, modelPreference: () => choice });
    try {
      if (choice === "removed-model") {
        await assert.rejects(
          f.adapter.start({
            cwd: f.draft,
            prompt: "fixture",
            requestType: "questions",
          }),
          /no substitute/,
        );
        assert.equal(
          f.messages.some((m) => m.method === "turn/start"),
          false,
        );
      } else {
        await f.adapter.start({
          cwd: f.draft,
          prompt: "fixture",
          requestType: "questions",
        });
        assert.equal(f.adapter.status().threads[0].model, choice);
      }
    } finally {
      f.cleanup();
    }
  }
});

test("background adapter warmup settles and does not continually rediscover models", async () => {
  const f = fixture();
  try {
    await Promise.all([f.adapter.warmModels(), f.adapter.warmModels()]);
    assert.equal(f.adapter.modelCatalogStatus().refreshing, false);
    const calls = f.messages.filter((m) => m.method === "model/list").length;
    await f.adapter.warmModels();
    assert.equal(
      f.messages.filter((m) => m.method === "model/list").length,
      calls,
    );
  } finally {
    f.cleanup();
  }
});

test("specialized workflows select their own settings even when sharing a task preset", () => {
  assert.equal(
    taskModelRequestType({
      preset: "questions",
      autofillContext: {
        url: "https://example.test",
        openingHash: "hash",
        knowledgeHash: "hash",
        questions: [],
      },
    }),
    "application-answers",
  );
  assert.equal(
    taskModelRequestType({
      preset: "opening-research",
      greenhousePull: { runId: "fixture", candidateId: "fixture" },
    }),
    "greenhouse-pull",
  );
  for (const preset of ["questions", "posting-application"] as const)
    assert.equal(
      taskModelRequestType({ preset }),
      preset satisfies ModelRequestType,
    );
});

test("the Settings table groups every request type exactly once", () => {
  const grouped = modelRequestGroups.flatMap((group) => group.requests);
  assert.deepEqual([...grouped].sort(), [...modelRequestTypes].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

test("older versions of a model family are hidden but a saved choice still resolves", async () => {
  const catalog = new CodexModelCatalog(async () => ({
    data: [
      model("gpt-6.1-sol", true),
      model("gpt-6-sol"),
      model("gpt-6-astra"),
      model("gpt-6.1-terra"),
    ],
    nextCursor: null,
  }));
  await catalog.refresh(true);
  const hidden = (id: string) =>
    catalog.status().models.find((entry) => entry.id === id)?.hidden;
  assert.equal(hidden("gpt-6-sol"), true);
  assert.equal(hidden("gpt-6.1-sol"), false);
  assert.equal(hidden("gpt-6-astra"), false);
  assert.deepEqual(catalog.resolve("gpt-6-sol"), {
    model: "gpt-6-sol",
    effort: "high",
  });
});

test("superseded models: higher version in the same family wins, equal versions and hidden newer models do not", () => {
  const ids = (models: CodexModel[]) =>
    hideSupersededModels(models)
      .filter((m) => m.hidden)
      .map((m) => m.id);
  assert.deepEqual(
    ids([
      model("claude-fable-5-1"),
      model("claude-fable-5-0"),
      model("claude-opus-5-5"),
    ]),
    ["claude-fable-5-0"],
  );
  assert.deepEqual(ids([model("gpt-6-sol"), model("gpt-6.0-sol")]), []);
  assert.deepEqual(
    ids([model("gpt-6-sol"), { ...model("gpt-6.1-sol"), hidden: true }]),
    ["gpt-6.1-sol"],
    "a newer model the API hides does not supersede the older one",
  );
});
