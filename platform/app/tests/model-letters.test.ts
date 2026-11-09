import test from "node:test";
import assert from "node:assert/strict";
import {
  hideSupersededModels,
  type CodexModel,
} from "../shared/codex-models.js";
import {
  assignLetters,
  effortLabel,
  effortLetters,
  modelLetterChoices,
  modelShortName,
} from "../shared/model-letters.js";

const model = (
  id: string,
  displayName: string,
  provider?: "claude",
  efforts = ["high", "xhigh", "max", "ultra"],
): CodexModel => ({
  id,
  model: id,
  displayName,
  ...(provider ? { provider } : {}),
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
  })),
});

const catalog = () =>
  hideSupersededModels([
    model("gpt-6.1-sol", "GPT-6.1-Sol"),
    model("gpt-6-astra", "GPT-6-Astra"),
    model("gpt-6.1-terra", "GPT-6.1 Terra"),
    model("gpt-6-sol", "GPT-6-Sol"),
    model("claude-fable-5-1", "Claude Fable 5.1", "claude", [
      "high",
      "xhigh",
      "max",
    ]),
    model("claude-opus-5-5", "Claude Opus 5.5", "claude", [
      "high",
      "xhigh",
      "max",
    ]),
  ]);

test("short names drop vendor words and keep name and version", () => {
  assert.deepEqual(modelShortName({ displayName: "GPT-6.1-Sol", model: "x" }), {
    name: "Sol",
    version: "6.1",
    short: "Sol 6.1",
  });
  assert.equal(
    modelShortName({ displayName: "GPT-6-Astra", model: "x" }).short,
    "Astra 6",
  );
  assert.equal(
    modelShortName({ displayName: "GPT-6.1 Terra", model: "x" }).short,
    "Terra 6.1",
  );
  assert.equal(
    modelShortName({ displayName: "Claude Fable 5.1", model: "x" }).short,
    "Fable 5.1",
  );
  assert.equal(
    modelShortName({ displayName: "Claude Opus 5.5", model: "x" }).short,
    "Opus 5.5",
  );
  assert.equal(
    modelShortName({ displayName: "GPT", model: "gpt-x" }).short,
    "gpt-x",
  );
  assert.equal(
    modelShortName({ displayName: "gpt-6-sol", model: "gpt-6-sol" }).short,
    "Sol 6",
  );
});

test("today's catalog gets S A T F O for models and H X M U for efforts", () => {
  const models = catalog();
  const choices = modelLetterChoices(models);
  assert.deepEqual(
    choices.map((entry) => entry.letter),
    ["S", "A", "T", "F", "O"],
  );
  assert.deepEqual(
    choices.map((entry) => entry.provider),
    ["codex", "codex", "codex", "claude", "claude"],
  );
  assert.deepEqual(
    effortLetters(models).map((entry) => entry.letter),
    ["H", "X", "M", "U"],
  );
});

test("superseded models are hidden and take no letter", () => {
  const models = catalog();
  assert.equal(models.find((entry) => entry.id === "gpt-6-sol")!.hidden, true);
  assert.equal(
    modelLetterChoices(models).some((entry) => entry.short === "Sol 6"),
    false,
  );
});

test("a letter taken earlier moves to the next unused character, then to the whole label", () => {
  const letters = (labels: string[]) =>
    assignLetters(labels, (label) => label).map((entry) => entry.letter);
  assert.deepEqual(letters(["Sol", "Sage", "Sao"]), ["S", "A", "O"]);
  assert.deepEqual(letters(["Ab", "Ba", "Ab"]), ["A", "B", "AB"]);
  assert.deepEqual(letters(["high", "xhigh", "max", "ultra"]), [
    "H",
    "X",
    "M",
    "U",
  ]);
});

test("a Claude model never reuses a Codex letter", () => {
  const models = [
    model("gpt-6.1-sol", "GPT-6.1-Sol"),
    model("claude-sonnet-5", "Claude Sonnet 5", "claude"),
  ];
  assert.deepEqual(
    modelLetterChoices(models).map((entry) => entry.letter),
    ["S", "O"],
  );
});

test("effort labels", () => {
  assert.equal(effortLabel("xhigh"), "Extra high");
  assert.equal(effortLabel("ultra"), "Ultra");
  assert.equal(effortLabel("minimal"), "Minimal");
});
