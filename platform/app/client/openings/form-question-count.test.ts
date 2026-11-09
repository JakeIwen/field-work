import test from "node:test";
import assert from "node:assert/strict";
import { createElement, render, fireEvent } from "../testing/test-render";
import { state, opening } from "../testing/component-fixtures";
const { FormQuestionCount } = await import("./FormQuestionCount");
const { Openings } = await import("../pages/Openings");

const result = { personal: [{ label: "I certify these answers are accurate", reason: "Acknowledge this yourself" }], narrative: 3 };

test("form count explains personal and narrative questions on hover, focus and tap", () => {
  const view = render(createElement(FormQuestionCount, { result }));
  const trigger = view.getByRole("button", { name: "1 questions may need your own answer" });
  assert.equal(trigger.textContent, "(1)");
  assert.equal(view.queryByRole("tooltip"), null);
  fireEvent.mouseEnter(trigger);
  assert.match(view.getByRole("tooltip").textContent ?? "", /1 questions may need your own answer/);
  assert.match(view.getByRole("tooltip").textContent ?? "", /I certify these answers are accurate/);
  assert.match(view.getByRole("tooltip").textContent ?? "", /3 written questions a model would draft/);
  assert.match(view.getByRole("tooltip").textContent ?? "", /Checked from the form without a model; drafting can still flag more/);
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(view.queryByRole("tooltip"), null);
  fireEvent.focus(trigger);
  assert.ok(view.getByRole("tooltip"));
  fireEvent.blur(trigger);
  assert.equal(view.queryByRole("tooltip"), null);
  fireEvent.click(trigger);
  assert.ok(view.getByRole("tooltip"));
});

test("Openings keeps the existing script count and shows a separate zero form count after Generate Docs", () => {
  const view = render(createElement(Openings, {
    state: { ...state, applications: [], tasks: [], openings: [{ ...opening, url: "https://job-boards.greenhouse.io/example/jobs/123" }], openingAutofillFinishCounts: { [opening.id]: 4 }, openingFormChecks: { [opening.id]: { personal: [], narrative: 2 } } },
    selected: "", go() {}, personal: async () => {}, mutate: async () => ({}),
  }));
  const count = view.getByRole("button", { name: "0 questions may need your own answer" });
  assert.equal(count.textContent, "(0)");
  assert.match(count.previousElementSibling?.textContent ?? "", /\(4\)/);
  fireEvent.click(count);
  assert.match(view.getByRole("tooltip").textContent ?? "", /2 written questions a model would draft/);
});

test("an unchecked form has no question-count trigger", () => {
  const view = render(createElement(FormQuestionCount, {}));
  assert.equal(view.queryByRole("button"), null);
});
