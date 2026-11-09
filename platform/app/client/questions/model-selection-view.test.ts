import test from "node:test";
import assert from "node:assert/strict";

const { createElement, renderToStaticMarkup } =
  await import("../testing/test-render.js");
const { NextTurnModel } = await import("./ModelSelection.js");

test("follow-up model label reflects the pinned provider without obsolete guidance", () => {
  const html = renderToStaticMarkup(
    createElement(NextTurnModel, {
      preferences: { questions: "claude-opus-5-5" },
      task: {
        preset: "questions",
        threadId: "saved",
        model: "gpt-6-astra",
        effort: "high",
      },
    }),
  );
  assert.match(html, /gpt-6-astra · high/);
  assert.doesNotMatch(html, /conversation stays|start a new conversation/);
});

test("same-provider follow-ups show the new saved model", () => {
  const html = renderToStaticMarkup(
    createElement(NextTurnModel, {
      preferences: { questions: "claude-fable-5-1" },
      task: {
        preset: "questions",
        threadId: "saved",
        model: "claude-opus-5-5",
        effort: "high",
      },
    }),
  );
  assert.match(html, /claude-fable-5-1 · high/);
  assert.doesNotMatch(html, /conversation stays/);
});
