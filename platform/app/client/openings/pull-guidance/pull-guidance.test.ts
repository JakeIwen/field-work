import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreenhousePullPolicy } from "../../../shared/greenhouse-policy";
const { createElement, fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { default: OpeningIntake } = await import("../OpeningIntake");
const { guidanceView, guidanceApp, chooseTerms } = await import("./guidance-test-fixture");
import type { AppState } from "../../../shared/types";
import type { GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";
import type { Mutate } from "../../workspace/workspace-actions";

test("editing guidance blocks a new pull, failed saves retain edits, and successful save uses the captured settings version", async () => {
  const calls: { path: string; body: GreenhouseGuidanceSave }[] = [];
  let fail = true;
  const mutate: Mutate = async (path, body) => {
    calls.push({ path, body });
    if (fail) throw Error("Save unavailable");
    return {};
  };
  const app = guidanceApp;
  const view = guidanceView(mutate);
  const instructions = view.getByLabelText("Instructions for new pulls") as HTMLTextAreaElement;
  const pull = view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement;
  fireEvent.change(instructions, { target: { value: "Include fractional alongside W-2" } });
  chooseTerms(view, ["react", "developer tools"]);
  assert.equal(pull.disabled, true);
  view.rerender(createElement(OpeningIntake, { state: { ...app, settings: { ...app.settings, version: 5 } }, mutate, go: () => {} }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Save unavailable/));
  assert.equal(instructions.value, "Include fractional alongside W-2");
  assert.equal(pull.disabled, true);
  assert.deepEqual(calls[0].body, {
    expectedVersion: 4, guidance: { instructions: "Include fractional alongside W-2", searchTerms: ["react", "developer tools"], employmentScope: ["full_time"] }, excludedCompanies: [], searchTermPool: [], policy: defaultGreenhousePullPolicy,
  } satisfies GreenhouseGuidanceSave);
  fireEvent.click(view.getByRole("button", { name: "Discard changes" }));
  assert.equal(pull.disabled, false);
  fireEvent.change(instructions, { target: { value: "New guidance" } });
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(pull.disabled, false));
  assert.equal(calls[1].body.expectedVersion, 5);
  assert.ok(calls.every(call => call.path === "/api/greenhouse/guidance"), "saving never starts a pull");
});

test("legacy end dates never appear and Clear leaves company exclusions and the custom pool intact", async () => {
  const { calls, mutate } = mutationRecorder();
  const app: AppState = { ...guidanceApp, settings: {
    ...guidanceApp.settings, greenhouseExcludedCompanies: ["Keep Excluded"], greenhouseSearchTermPool: ["fractional"],
    // Saved before end dates were retired; the field no longer exists in the type.
    greenhouseGuidance: Object.assign({ instructions: "Old focus", searchTerms: ["fractional"], employmentScope: ["full_time" as const, "contract" as const] }, { throughDate: "2020-01-01" }),
  } };
  const view = guidanceView(mutate, app);
  assert.ok(view.getByText("Pull instructions · Saved"));
  assert.equal(view.container.querySelector('input[type="date"]'), null);
  assert.doesNotMatch(view.container.textContent!, /Use through|Expired|Through |2020-01-01/);
  fireEvent.click(view.getByRole("button", { name: "Clear instructions" }));
  assert.equal(calls.length, 0);
  assert.equal((view.getByLabelText("Instructions for new pulls") as HTMLTextAreaElement).value, "");
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0].body, { expectedVersion: 4, guidance: { instructions: "", searchTerms: [], employmentScope: ["full_time"] }, excludedCompanies: ["Keep Excluded"], searchTermPool: ["fractional"], policy: defaultGreenhousePullPolicy });
});

test("employment checkboxes save preferences, keep dirty state and clear with other guidance", async () => {
  const { calls, mutate } = mutationRecorder();
  const app = guidanceApp;
  const view = guidanceView(mutate);
  const contract = view.getByRole("checkbox", { name: "Contract" }) as HTMLInputElement;
  assert.equal(contract.checked, false);
  assert.equal((view.getByRole("checkbox", { name: "Part time" }) as HTMLInputElement).checked, false);
  fireEvent.click(contract);
  fireEvent.click(view.getByRole("checkbox", { name: "Temporary" }));
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const saved = (calls[0].body as GreenhouseGuidanceSave).guidance;
  assert.deepEqual(saved.employmentScope, ["full_time", "contract", "temporary"]);
  view.rerender(createElement(OpeningIntake, { state: { ...app, settings: { ...app.settings, version: 5, greenhouseGuidance: saved } }, mutate, go: () => {} }));
  assert.equal(contract.checked, true);
  fireEvent.click(view.getByRole("button", { name: "About employment type searches" }));
  assert.match(view.getByRole("tooltip").textContent!, /Pulls search for and keep only the checked types/);
  fireEvent.click(view.getByRole("button", { name: "Clear instructions" }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual((calls[1].body as GreenhouseGuidanceSave).guidance.employmentScope, ["full_time"]);
});

test("pull coverage distinguishes the same query with Contract and regular filters", () => {
  const app: AppState = { ...guidanceApp, greenhousePull: {
    id: "run", target: 10, status: "paused", phase: "Paused", discovered: 0, reviewed: 0, existing: 0, excluded: 0, deferred: 0, added: 0, pending: 0,
    query: "software engineer", page: 1, addedOpeningIds: [], createdAt: "2026-09-28", updatedAt: "2026-09-28",
    searches: [{ query: "software engineer", employmentTypes: ["contract"], pages: 1, exhausted: true }, { query: "software engineer", pages: 0, exhausted: false }],
  } };
  const view = guidanceView(async () => {}, app);
  assert.ok(view.getByText("software engineer · Contract · 1 page checked · searched to the end"));
  assert.ok(view.getByText("software engineer · Not searched yet"));
});


test("employment scope defaults to Full time, keeps one checked and saves choices in label order", async () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  const group = view.getByRole("group", { name: "Employment type" });
  assert.deepEqual([...group.querySelectorAll("label")].map(label => label.textContent), ["Full time", "Contract", "Part time", "Temporary"]);
  const fullTime = view.getByRole("checkbox", { name: "Full time" }) as HTMLInputElement;
  const contract = view.getByRole("checkbox", { name: "Contract" }) as HTMLInputElement;
  assert.equal(fullTime.checked, true);
  assert.equal(fullTime.disabled, true);
  assert.ok(view.getByText("Pull instructions"));
  assert.equal(view.queryByRole("button", { name: "Clear instructions" }), null);
  fireEvent.click(contract);
  assert.equal(fullTime.disabled, false);
  fireEvent.click(fullTime);
  assert.equal(contract.disabled, true);
  assert.equal(contract.checked, true);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const saved = (calls[0].body as GreenhouseGuidanceSave).guidance;
  assert.deepEqual(saved.employmentScope, ["contract"]);
  view.rerender(createElement(OpeningIntake, { state: { ...guidanceApp, settings: { ...guidanceApp.settings, greenhouseGuidance: saved } }, mutate, go: () => {} }));
  fireEvent.click(view.getByRole("checkbox", { name: "Temporary" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Part time" }));
  fireEvent.click(fullTime);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual((calls[1].body as GreenhouseGuidanceSave).guidance.employmentScope, ["full_time", "contract", "part_time", "temporary"]);
});

test("saved default scope is not configured and extra terms explain the selected scope", () => {
  const view = guidanceView(async () => {}, { ...guidanceApp, settings: { ...guidanceApp.settings, greenhouseGuidance: { instructions: "", searchTerms: [], employmentScope: ["full_time"] } } });
  assert.ok(view.getByText("Pull instructions"));
  assert.equal(view.queryByRole("button", { name: "Clear instructions" }), null);
  fireEvent.click(view.getByRole("button", { name: "About extra search terms" }));
  assert.match(view.getByRole("tooltip").textContent!, /they use the checked employment types/);
});
