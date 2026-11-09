import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixtures/codex-fixture.js";
import { CodexModelCatalog } from "../server/codex-model-catalog.js";
import { validateModelPreferences } from "../server/model-preferences.js";
import {
  configuredSelection,
  defaultSelectionLabel,
} from "../shared/model-selection.js";
import { modelRequestTypes, type CodexModel } from "../shared/codex-models.js";

test("every request type sends its saved effort to both thread and turn startup", async () => {
  for (const requestType of modelRequestTypes) {
    const f = fixture({
      effortPreference: (type) => (type === requestType ? "high" : undefined),
    });
    try {
      await f.adapter.start({ cwd: f.draft, prompt: "Fixture", requestType });
      assert.equal(
        f.messages.find((message) => message.method === "thread/start").params
          .config.model_reasoning_effort,
        "high",
        requestType,
      );
      assert.equal(
        f.messages.find((message) => message.method === "turn/start").params
          .effort,
        "high",
        requestType,
      );
      assert.equal(f.adapter.status().threads[0].effort, "high");
    } finally {
      f.cleanup();
    }
  }
});

test("saved effort changes preserve active turns and take effect on follow-up and reconnect", async () => {
  let effort = "high";
  const f = fixture({ effortPreference: () => effort });
  let reconnected: ReturnType<typeof f.create> | undefined;
  try {
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "First",
      requestType: "questions",
    });
    effort = "ultra";
    await f.adapter.resume(first.threadId);
    assert.equal(f.adapter.status().threads[0].effort, "high");
    await assert.rejects(
      f.adapter.send(first.threadId, "Still active"),
      /active turn/,
    );
    await f.adapter.interrupt(first.threadId);
    await f.adapter.send(first.threadId, "Follow-up");
    assert.equal(
      f.messages.filter((message) => message.method === "turn/start").at(-1)
        .params.effort,
      "ultra",
    );
    assert.equal(
      f.events.find((event) => event.method === "adapter/threadCreated").params
        .effort,
      "high",
    );
    await f.adapter.interrupt(first.threadId);
    await f.adapter.close();
    effort = "ultra";
    reconnected = f.create();
    await reconnected.send(first.threadId, "After reconnect");
    assert.equal(
      f.messages.filter((message) => message.method === "turn/start").at(-1)
        .params.effort,
      "ultra",
    );
  } finally {
    await reconnected?.close();
    f.cleanup();
  }
});

test("unsupported saved effort and provider effort substitutions never start a turn", async () => {
  const unsupported = fixture({ effortPreference: () => "unadvertised" });
  try {
    await assert.rejects(
      unsupported.adapter.start({
        cwd: unsupported.draft,
        prompt: "Fixture",
        requestType: "questions",
      }),
      /does not support.*unadvertised/,
    );
    assert.equal(
      unsupported.messages.some((message) => message.method === "thread/start"),
      false,
    );
  } finally {
    unsupported.cleanup();
  }
  const substituted = fixture({
    effortPreference: () => "ultra",
    returnedEffort: "high",
  });
  try {
    await assert.rejects(
      substituted.adapter.start({ cwd: substituted.draft, prompt: "Fixture" }),
      /effort/i,
    );
    assert.equal(
      substituted.messages.some((message) => message.method === "turn/start"),
      false,
    );
  } finally {
    substituted.cleanup();
  }
});

test("an explicit supported effort override is retained for its saved conversation", async () => {
  const f = fixture({ effortPreference: () => "high" });
  try {
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "Fixture",
      effort: "ultra",
    });
    await f.adapter.interrupt(first.threadId);
    await f.adapter.send(first.threadId, "Follow-up");
    assert.ok(
      f.messages
        .filter((message) => message.method === "turn/start")
        .every((message) => message.params.effort === "ultra"),
    );
  } finally {
    f.cleanup();
  }
});

const advertised: CodexModel = {
  id: "fixture",
  model: "fixture",
  displayName: "Fixture",
  isDefault: true,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "More deliberate." },
    { reasoningEffort: "low", description: "Quicker." },
    { reasoningEffort: "medium", description: "Balanced." },
    {
      reasoningEffort: "future-effort",
      description: "Advertised by the provider.",
    },
  ],
};
const offeredAdvertised = [
  { reasoningEffort: "high", description: "More deliberate." },
  {
    reasoningEffort: "future-effort",
    description: "Advertised by the provider.",
  },
];

test("catalog efforts remain dynamic and retain their advertised order and descriptions", async () => {
  const catalog = new CodexModelCatalog(async () => ({
    data: [advertised],
    nextCursor: null,
  }));
  await catalog.refresh();
  assert.deepEqual(
    catalog.status().models[0].supportedReasoningEfforts,
    offeredAdvertised,
  );
  assert.deepEqual(catalog.resolve(undefined, "future-effort"), {
    model: "fixture",
    effort: "future-effort",
  });
  assert.throws(() => catalog.resolve(undefined, "ultra"), /does not support/);
  const xhighOnly = new CodexModelCatalog(async () => ({
    data: [
      {
        ...advertised,
        supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
      },
    ],
  }));
  await xhighOnly.refresh();
  assert.equal(xhighOnly.available, true);
  assert.equal(xhighOnly.selected, null);
  assert.equal(xhighOnly.resolve(undefined, "xhigh").effort, "xhigh");
});

test("catalog removes withdrawn models and reasoning efforts", async () => {
  const model = (name: string, isDefault = false): CodexModel => ({
    id: name,
    model: name,
    displayName: name,
    isDefault,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ],
  });
  const page = {
    data: [
      model("gpt-5.6-sol"),
      model("gpt-5.5"),
      model("gpt-6-luna"),
      model("gpt-6-sol", true),
      model("gpt-6-astra"),
    ],
    nextCursor: null,
  };
  const catalog = new CodexModelCatalog(async () => page);
  await catalog.refresh();
  assert.deepEqual(
    catalog.status().models.map((entry) => entry.model),
    ["gpt-6-sol", "gpt-6-astra"],
  );
  assert.deepEqual(
    catalog
      .status()
      .models.map((entry) =>
        entry.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      ),
    [
      ["high", "xhigh"],
      ["high", "xhigh"],
    ],
  );
  assert.throws(() => catalog.resolve("gpt-5.6-sol"), /unavailable/);
  assert.throws(() => catalog.resolve("gpt-6-luna"), /unavailable/);
  assert.throws(() => catalog.resolve("gpt-6-sol", "low"), /does not support/);
});

test("model settings validate model/effort pairs and preserve unchanged unavailable selections", () => {
  const catalog = {
    models: [advertised],
    error: null,
    refreshedAt: null,
    refreshing: false,
  };
  assert.deepEqual(
    validateModelPreferences({}, { "greenhouse-pull": "high" }, {}, catalog),
    {
      codexModels: {},
      codexEfforts: { "greenhouse-pull": "high" },
    },
  );
  for (const invalid of [
    null,
    [],
    { unknown: "xhigh" },
    { questions: 7 },
    { questions: "ultra" },
  ])
    assert.throws(() => validateModelPreferences({}, invalid, {}, catalog));
  const previous = {
    codexModels: { questions: "removed" },
    codexEfforts: { questions: "old-effort" },
  };
  assert.deepEqual(
    validateModelPreferences(
      { questions: "removed", "greenhouse-pull": "fixture" },
      previous.codexEfforts,
      previous,
      catalog,
    ).codexEfforts,
    previous.codexEfforts,
  );
  assert.throws(() =>
    validateModelPreferences(
      previous.codexModels,
      { questions: "ultra" },
      previous,
      catalog,
    ),
  );
  assert.deepEqual(
    validateModelPreferences(
      previous.codexModels,
      undefined,
      previous,
      catalog,
    ),
    previous,
  );
  assert.deepEqual(
    validateModelPreferences({}, {}, previous, {
      ...catalog,
      error: "offline",
    }),
    { codexModels: {}, codexEfforts: {} },
  );
  assert.throws(() =>
    validateModelPreferences(
      {},
      { questions: "ultra" },
      {},
      { ...catalog, error: "offline" },
    ),
  );
});

test("upcoming selection labels combine independent saved model and effort preferences", () => {
  const fallback = { model: "recommended", effort: "high" };
  assert.deepEqual(
    configuredSelection({}, "questions", fallback, { questions: "ultra" }),
    { model: "recommended", effort: "ultra" },
  );
  assert.deepEqual(
    configuredSelection({ questions: "saved" }, "questions", fallback),
    { model: "saved", effort: "high" },
  );
  assert.equal(
    defaultSelectionLabel({ questions: "xhigh" }, "questions"),
    "Codex default · xhigh",
  );
});
