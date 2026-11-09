import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, mutationRecorder } = await import("../testing/test-render");
const { within } = await import("@testing-library/react");
const { default: OpeningIntake } = await import("./OpeningIntake");
import { state } from "../testing/component-fixtures";
import type { GreenhousePullSummary } from "../../shared/greenhouse-pull";

const run: GreenhousePullSummary = {
  id: "pull-summary", query: "software engineer", page: 1, target: 50, status: "running", phase: "Researching",
  discovered: 60, reviewed: 40, existing: 5, excluded: 10, deferred: 2, added: 34, pending: 9, remembered: 3,
  parallelReviews: 6, effectiveParallelReviews: 8,
  addedOpeningIds: [], createdAt: "2026-10-22T12:00:00Z", updatedAt: "2026-10-22T12:00:03Z",
  reviews: [
    { taskId: "running-1", title: "First running review", status: "running" },
    { taskId: "running-2", title: "Second running review", status: "running" },
    { taskId: "queued", title: "Queued review", status: "queued" },
    { taskId: "waiting", title: "Waiting review", status: "waiting for input" },
    { taskId: "completed", title: "Completed review", status: "completed" },
  ],
};
const { mutate } = mutationRecorder();
const props = (greenhousePull: GreenhousePullSummary) => ({ state: { ...state, greenhousePull }, mutate, go: () => {} });
const summaryText = (container: HTMLElement) => container.querySelector(".intake-status > .intake-summary > summary")?.textContent ?? "";

test("pull summary counts only Researching sessions and refreshes the effective live limit", () => {
  const view = render(createElement(OpeningIntake, props(run)));
  assert.match(summaryText(view.container), /Pull · Greenhouse · 34 of 50 added · Working · 2 of 8 reviews running/);
  view.rerender(createElement(OpeningIntake, props({ ...run, effectiveParallelReviews: 1 })));
  assert.match(summaryText(view.container), /2 of 1 reviews running/, "a decrease may leave running reviews above the new limit");
  view.rerender(createElement(OpeningIntake, props({ ...run, reviews: [] })));
  assert.match(summaryText(view.container), /0 of 8 reviews running/);
});

test("review counts remain while cooling down, finishing, paused or stopped with running reviews", () => {
  const view = render(createElement(OpeningIntake, props(run)));
  for (const status of ["cooldown", "finishing", "paused", "stopped", "failed"] as const) {
    view.rerender(createElement(OpeningIntake, props({ ...run, status })));
    assert.match(summaryText(view.container), /2 of 8 reviews running/);
  }
  for (const status of ["paused", "stopped", "target_reached", "exhausted", "failed"] as const) {
    view.rerender(createElement(OpeningIntake, props({ ...run, status, reviews: [] })));
    assert.doesNotMatch(summaryText(view.container), /reviews running/);
  }
  for (const status of ["running", "cooldown", "finishing"] as const) {
    view.rerender(createElement(OpeningIntake, props({ ...run, status, reviews: [] })));
    assert.match(summaryText(view.container), /0 of 8 reviews running/);
  }
});

test("pull count tooltip lists each term and explains which counts overlap without changing the visible stats", () => {
  const view = render(createElement(OpeningIntake, props(run)));
  const help = view.getByRole("button", { name: "About pull counts" });
  assert.equal(help.closest("p")?.textContent, "60 discovered · 40 researched · 5 already saved · 10 excluded · 2 deferred · 9 remaining · 3 reviewed in earlier pulls ");
  assert.equal(view.queryByRole("tooltip"), null);
  fireEvent.focus(help);
  const tip = view.getByRole("tooltip");
  assert.equal(within(tip).getAllByRole("listitem").length, 9);
  for (const term of ["Discovered", "Researched", "Already saved", "Excluded", "Deferred", "Remaining", "Reviewed in earlier pulls", "Added", "Totals"]) {
    assert.ok(within(tip).getByText(`${term}:`));
  }
  assert.match(tip.textContent ?? "", /Agent reviews whose decisions have been processed/);
  assert.match(tip.textContent ?? "", /title or company filters, the freshness window, C#\/\.NET/);
  assert.match(tip.textContent ?? "", /required travel above 5%/);
  assert.match(tip.textContent ?? "", /location, employment scope or fit/);
  assert.match(tip.textContent ?? "", /also count as added, already saved, excluded or deferred/);
  assert.match(tip.textContent ?? "", /Also counted as excluded or deferred, not as newly researched/);
  assert.match(tip.textContent ?? "", /Added \+ already saved \+ excluded \+ deferred \+ remaining = discovered/);
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(view.queryByRole("tooltip"), null);
});
