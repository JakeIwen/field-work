import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../testing/test-render");
const { default: GreenhousePacing } = await import("./GreenhousePacing");
const { default: OpeningIntake } = await import("../openings/OpeningIntake");
import { state } from "../testing/component-fixtures";
import type { AppState } from "../../shared/types";
import type { Mutate } from "../workspace/workspace-actions";
import type { GreenhousePullSummary } from "../../shared/greenhouse-pull";

const pull: GreenhousePullSummary = {
  id: "run", target: 10, status: "paused", phase: "Paused", discovered: 0, reviewed: 0, existing: 0,
  excluded: 0, deferred: 0, added: 0, pending: 0, query: "software engineer", page: 1,
  addedOpeningIds: [], createdAt: "2026-10-22", updatedAt: "2026-10-22",
};

test("pull settings share one form and aligned field structure, with tooltip-only help", () => {
  const view = render(createElement(GreenhousePacing, { state, mutate: async () => {}, notify: () => {} }));
  const form = view.getByRole("form", { name: "Greenhouse pull settings" });
  const inputs = view.getAllByRole("spinbutton") as HTMLInputElement[];
  assert.equal(form.querySelectorAll(".greenhouse-pull-fields").length, 1);
  assert.equal(form.querySelectorAll(".greenhouse-pull-field").length, 3);
  assert.equal(form.querySelectorAll("button[type=submit], button:not([type])").length, 1);
  assert.ok(view.getByRole("button", { name: "Save" }));
  assert.equal(view.queryByLabelText("Excluded companies"), null);
  for (const input of inputs) {
    const field = input.parentElement!;
    assert.equal(field.className, "greenhouse-pull-field");
    assert.equal(field.children[0].className, "heading-help");
    assert.equal(field.children[1], input);
    assert.equal(field.children[0].children[0].tagName, "LABEL");
    assert.equal(field.querySelectorAll(".heading-help button").length, 1);
  }
  assert.equal(view.queryByRole("tooltip"), null);
  fireEvent.click(view.getByRole("button", { name: "About Greenhouse page interval" }));
  assert.match(view.getByRole("tooltip").textContent!, /Manual changes apply to the next pull/);
  fireEvent.keyDown(view.getByRole("button", { name: "About Greenhouse page interval" }), { key: "Escape" });
  fireEvent.click(view.getByRole("button", { name: "About parallel reviews" }));
  assert.equal(view.getByRole("tooltip").textContent, "How many reviews a pull runs at once. Changes apply to active pulls without interrupting running reviews.");
});

test("pull settings validate each field's bounds below its input", () => {
  const view = render(createElement(GreenhousePacing, { state, mutate: async () => {}, notify: () => {} }));
  for (const [label, min, max, message] of [
    ["Page interval (ms)", 1000, 60000, "Enter whole milliseconds from 1000 to 60000."],
    ["Parallel reviews", 1, 10, "Enter a whole number from 1 to 10."],
    ["Search lookahead", 1, 40, "Enter a whole number from 1 to 40."],
  ] as const) {
    const input = view.getByLabelText(label) as HTMLInputElement;
    assert.equal(input.min, String(min)); assert.equal(input.max, String(max));
    for (const value of [String(min - 1), String(max + 1), String(min + 0.5), ""]) {
      fireEvent.change(input, { target: { value } });
      assert.equal((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
      assert.equal(input.parentElement!.querySelector("[role=alert]")!.textContent, message);
    }
    fireEvent.click(view.getByRole("button", { name: "Use current values" }));
  }
});

test("combined save retains failed edits and captured version; reset uses current settings", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let fail = true;
  const mutate: Mutate = async (path, body) => { calls.push({ path, body }); if (fail) throw Error("Settings changed"); };
  const app: AppState = { ...state, settings: { timezone: "America/Denver", version: 4 } };
  const props = { state: app, mutate, notify: () => {} };
  const view = render(createElement(GreenhousePacing, props));
  const input = view.getByLabelText("Page interval (ms)") as HTMLInputElement;
  assert.equal(input.value, "2000");
  fireEvent.change(input, { target: { value: "3500" } });
  const changed = { ...app, settings: { ...app.settings, version: 5, greenhousePacingRate: 4000, parallelReviews: 10 } };
  view.rerender(createElement(GreenhousePacing, { ...props, state: changed }));
  assert.equal(input.value, "3500");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Settings changed/));
  assert.deepEqual(calls[0], { path: "/api/greenhouse/pull-settings", body: { expectedVersion: 4, pacingRate: 3500, parallelReviews: 6, searchLookahead: 6, formCheckNewOpenings: true } });
  fireEvent.click(view.getByRole("button", { name: "Use current values" }));
  assert.equal(input.value, "4000");
  assert.equal((view.getByLabelText("Parallel reviews") as HTMLInputElement).value, "10");
  assert.equal((view.getByLabelText("Search lookahead") as HTMLInputElement).value, "10");
  fireEvent.change(input, { target: { value: "1000" } });
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], { path: "/api/greenhouse/pull-settings", body: { expectedVersion: 5, pacingRate: 1000, parallelReviews: 10, searchLookahead: 10, formCheckNewOpenings: true } });
});

test("parallel edits reset lookahead to the formula; later manual overrides save explicitly", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const app: AppState = { ...state, settings: { timezone: "America/Denver", version: 4, parallelReviews: 6, greenhouseSearchLookahead: 20 } };
  const view = render(createElement(GreenhousePacing, { state: app, mutate: async (path, body) => { calls.push({ path, body }); }, notify: () => {} }));
  const parallel = view.getByLabelText("Parallel reviews") as HTMLInputElement;
  const lookahead = view.getByLabelText("Search lookahead") as HTMLInputElement;
  assert.equal(lookahead.value, "20");
  fireEvent.change(parallel, { target: { value: "8" } });
  assert.equal(lookahead.value, "8");
  fireEvent.change(lookahead, { target: { value: "30" } });
  fireEvent.change(parallel, { target: { value: "9" } });
  assert.equal(lookahead.value, "9");
  fireEvent.change(lookahead, { target: { value: "40" } });
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.deepEqual(calls, [{ path: "/api/greenhouse/pull-settings", body: { expectedVersion: 4, pacingRate: 2000, parallelReviews: 9, searchLookahead: 40, formCheckNewOpenings: true } }]));
});

test("adaptive status reports the saved floor, penalty and effective interval; clear uses the version-checked combined save", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const app: AppState = { ...state, settings: { timezone: "America/Denver", version: 4, greenhousePacingRate: 2000, greenhousePacingPenaltyMs: 1000 } };
  let fail = true;
  const props = { state: app, mutate: async (path: string, body: unknown) => { calls.push({ path, body }); if (fail) throw Error("Settings changed"); }, notify: () => {} };
  const view = render(createElement(GreenhousePacing, props));
  assert.equal((view.getByLabelText("Page interval (ms)") as HTMLInputElement).value, "2000");
  assert.equal(view.getByRole("status").textContent, "now 2 s + 1 s adaptive = 3 s");
  const clear = view.getByRole("button", { name: "Clear adaptive delay" }) as HTMLButtonElement;
  assert.ok(clear.classList.contains("text-button"));
  fireEvent.click(clear);
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Settings changed/));
  assert.deepEqual(calls[0], { path: "/api/greenhouse/pull-settings", body: { expectedVersion: 4, pacingRate: 2000, parallelReviews: 6, searchLookahead: 6, formCheckNewOpenings: true, pacingPenaltyMs: 0 } });
  assert.equal(view.getByRole("status").textContent, "now 2 s + 1 s adaptive = 3 s");
  fail = false;
  fireEvent.change(view.getByLabelText("Page interval (ms)"), { target: { value: "3500" } });
  fireEvent.click(clear);
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], { path: "/api/greenhouse/pull-settings", body: { expectedVersion: 4, pacingRate: 3500, parallelReviews: 6, searchLookahead: 6, formCheckNewOpenings: true, pacingPenaltyMs: 0 } });
  view.rerender(createElement(GreenhousePacing, { ...props, state: { ...app, settings: { ...app.settings, version: 5, greenhousePacingRate: 3500, greenhousePacingPenaltyMs: 0 } } }));
  assert.equal(view.getByRole("status").textContent, "now 3.5 s + 0 s adaptive = 3.5 s");
  assert.equal(clear.disabled, true);
});

test("missing adaptive delay defaults to zero", () => {
  const view = render(createElement(GreenhousePacing, { state: { ...state, settings: { timezone: "America/Denver" } }, mutate: async () => {}, notify: () => {} }));
  assert.equal(view.getByRole("status").textContent, "now 2 s + 0 s adaptive = 2 s");
  assert.equal((view.getByRole("button", { name: "Clear adaptive delay" }) as HTMLButtonElement).disabled, true);
});

test("Stop searching is immediate and never blocks on a review confirmation", async () => {
  for (const status of ["running", "handoff", "completed"] as const) {
    const calls: unknown[] = [];
    const app: AppState = { ...state, tasks: [], greenhousePull: { ...pull, status: "running", reviews: [{ taskId: "task", title: "Company · Engineer", status }] } };
    const view = render(createElement(OpeningIntake, { state: app, go: () => {}, mutate: async (_path, body) => { calls.push(body); } }));
    fireEvent.click(view.getByRole("button", { name: "Stop pull" }));
    await waitFor(() => assert.deepEqual(calls, [{ action: "stop" }]));
    assert.equal(view.queryByRole("group", { name: "Stop pull options" }), null);
    view.unmount();
  }
});

test("finishing details offer non-blocking Stop reviews and allow a new pull", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const app: AppState = { ...state, tasks: [], greenhousePull: { ...pull, status: "finishing", phase: "Target reached; finishing 7 reviews", added: 10, pending: 7, reviews: [{ taskId: "task", title: "Company · Engineer", status: "running" }] } };
  const view = render(createElement(OpeningIntake, { state: app, go: () => {}, mutate: async (path, body) => { calls.push({ path, body }); } }));
  assert.ok(view.getByText("Target reached; finishing 7 reviews"));
  const stop = view.getByRole("button", { name: "Stop reviews (7 left)" });
  assert.ok(stop.classList.contains("secondary"));
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, false);
  fireEvent.click(stop);
  await waitFor(() => assert.deepEqual(calls[0], { path: "/api/greenhouse/pulls/run/action", body: { action: "stop_reviews" } }));
  await waitFor(() => assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByRole("button", { name: "Pull listings" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].path, "/api/greenhouse/pulls");
  assert.equal((calls[1].body as { target: number }).target, 10);
});

test("stop without active reviews sends the default directly", async () => {
  const calls: unknown[] = [];
  const view = render(createElement(OpeningIntake, { state: { ...state, tasks: [], greenhousePull: pull }, go: () => {}, mutate: async (_path, body) => { calls.push(body); } }));
  fireEvent.click(view.getByRole("button", { name: "Stop pull" }));
  await waitFor(() => assert.deepEqual(calls, [{ action: "stop" }]));
});

test("pull details show initial/current or final intervals and unchanged results, including URL fallback", () => {
  const app: AppState = { ...state, tasks: [], greenhousePull: { ...pull, initialPacingRate: 2000, pacingRate: 4000, parallelReviews: 10 } };
  const props = { state: app, mutate: async () => {}, go: () => {} };
  const view = render(createElement(OpeningIntake, props));
  assert.ok(view.getByText("Page interval: 2.0 s → 4.0 s"));
  assert.ok(view.getByText("Parallel reviews: 10"));
  view.rerender(createElement(OpeningIntake, { ...props, state: { ...app, greenhousePull: { ...app.greenhousePull!, searchLookahead: 30 } } }));
  assert.ok(view.getByText("Parallel reviews: 10 · Search lookahead: 30"));
  view.rerender(createElement(OpeningIntake, { ...props, state: { ...app, greenhousePull: {
    ...pull, status: "exhausted", initialPacingRate: 2000, pacingRate: 4000, finalPacingRate: 4000,
    searchTransport: "navigation", searchTransportNote: "MyGreenhouse userscript not detected; loading pages by URL",
  } } }));
  assert.ok(view.getByText("Page interval: 2.0 s → 4.0 s · Loading pages by URL"));
  assert.ok(view.getByText("MyGreenhouse userscript not detected; loading pages by URL"));
  view.rerender(createElement(OpeningIntake, { ...props, state: { ...app, greenhousePull: {
    ...pull, status: "stopped", initialPacingRate: 2000, pacingRate: 2000, finalPacingRate: 2000,
  } } }));
  assert.ok(view.getByText("Page interval: 2.0 s, unchanged"));
});

test("form-check checkbox is checked by default, unchecked when saved false, and saves with the form", async () => {
  const view = render(createElement(GreenhousePacing, { state, mutate: async () => {}, notify: () => {} }));
  const box = view.getByLabelText("Check form questions for new openings") as HTMLInputElement;
  assert.equal(box.checked, true);
  assert.ok(view.getByRole("button", { name: "About checking form questions for new openings" }));
  assert.equal((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(box);
  assert.equal(box.checked, false);
  assert.equal((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false);
  view.unmount?.();
  const off: AppState = { ...state, settings: { ...state.settings, greenhouseFormCheckNewOpenings: false } };
  const calls: unknown[] = [];
  const mutate: Mutate = async (_path, body) => { calls.push(body); };
  const second = render(createElement(GreenhousePacing, { state: off, mutate, notify: () => {} }));
  const unchecked = second.getByLabelText("Check form questions for new openings") as HTMLInputElement;
  assert.equal(unchecked.checked, false);
  fireEvent.click(unchecked);
  fireEvent.click(second.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal((calls[0] as { formCheckNewOpenings: boolean }).formCheckNewOpenings, true));
});
