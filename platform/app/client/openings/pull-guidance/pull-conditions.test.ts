import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreenhousePullPolicy, greenhouseDefaultRegularSearchTerms, greenhousePolicyProblem, type CapturedGreenhousePolicy } from "../../../shared/greenhouse-policy";
import type { GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";
const { createElement, fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { default: OpeningIntake } = await import("../OpeningIntake");
const { guidanceView, guidanceApp } = await import("./guidance-test-fixture");

const ageLabel = "Maximum age since original publication (days)";
const travelLabel = "Maximum required travel (%)";
const languageLabel = "Exclude roles defined by a language not on the resume";
const reuseLabel = "Reuse earlier review decisions";
const titleLabel = "Skip clearly non-software titles before retrieval";
const defaultSummary = "7 days · travel ≤ 5% · language rule on · reuse reviews on (deferrals 72 h) · title skip on · 8 search terms";
const captured: CapturedGreenhousePolicy = {
  ...defaultGreenhousePullPolicy, freshnessDays: 3, travelCapPercent: null, excludeMissingLanguage: false,
  reuseReviews: false, titleTriage: false, regularSearchTerms: ["backend"], policyVersion: 1,
  capturedAt: "2026-10-30T00:00:00Z", titleExcludeTerms: ["sales"], technologyExcludeTerms: ["C#"], excludedCompanies: ["Skipped Co"],
};
const run = {
  id: "run", target: 10, status: "paused" as const, phase: "Paused", discovered: 0, reviewed: 0, existing: 0,
  excluded: 0, deferred: 0, added: 0, pending: 0, query: "backend", page: 1,
  addedOpeningIds: [], createdAt: "2026-10-30", updatedAt: "2026-10-30",
};

test("conditions fill defaults and explain each control without changing saved state", () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  assert.ok(view.getByRole("group", { name: "Conditions" }));
  assert.equal((view.getByLabelText(ageLabel) as HTMLInputElement).value, "7");
  assert.equal((view.getByLabelText(travelLabel) as HTMLInputElement).value, "5");
  assert.equal((view.getByRole("checkbox", { name: "No cap" }) as HTMLInputElement).checked, false);
  for (const name of [languageLabel, reuseLabel, titleLabel]) assert.equal((view.getByRole("checkbox", { name }) as HTMLInputElement).checked, true);
  assert.equal((view.getByLabelText("Deferrals count for (hours)") as HTMLInputElement).value, "72");
  assert.ok(view.getByText(`New pull conditions: ${defaultSummary}`));
  assert.equal((view.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "About maximum publication age" }));
  assert.match(view.getByRole("tooltip").textContent!, /original publication date.*past ten days.*plus one day/);
  assert.equal(calls.length, 0);
});

test("the card date margin text follows the saved margin", () => {
  const view = guidanceView(async () => {}, { ...guidanceApp, settings: { ...guidanceApp.settings, tunables: { "greenhouse.cardDateMarginDays": 3 } } });
  fireEvent.click(view.getByRole("button", { name: "About maximum publication age" }));
  assert.match(view.getByRole("tooltip").textContent!, /plus 3 days/);
});

test("a saved default policy is not shown as configured merely because its keys were reordered", () => {
  const { regularSearchTerms, ...rest } = defaultGreenhousePullPolicy;
  const greenhousePolicy = { regularSearchTerms, ...rest };
  const view = guidanceView(async () => {}, { ...guidanceApp, settings: { ...guidanceApp.settings, greenhousePolicy } });
  assert.ok(view.getByText("Pull instructions"));
  assert.equal(view.queryByText("Pull instructions · Saved"), null);
});

test("condition edits block new pulls and save null travel with all other draft choices", async () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  fireEvent.change(view.getByLabelText(ageLabel), { target: { value: "4" } });
  fireEvent.click(view.getByRole("checkbox", { name: "No cap" }));
  assert.equal((view.getByLabelText(travelLabel) as HTMLInputElement).disabled, true);
  fireEvent.click(view.getByRole("checkbox", { name: languageLabel }));
  fireEvent.change(view.getByLabelText("Deferrals count for (hours)"), { target: { value: "120" } });
  fireEvent.click(view.getByRole("checkbox", { name: reuseLabel }));
  assert.equal(view.queryByLabelText("Deferrals count for (hours)"), null);
  fireEvent.click(view.getByRole("checkbox", { name: titleLabel }));
  assert.ok(view.getByText("Pull instructions · Unsaved changes"));
  assert.ok(view.getByText(`New pull conditions: ${defaultSummary}`), "summary is saved settings, not draft");
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const body = calls[0].body as GreenhouseGuidanceSave;
  assert.deepEqual(body.policy, { ...defaultGreenhousePullPolicy, freshnessDays: 4, travelCapPercent: null, excludeMissingLanguage: false, reuseReviews: false, deferralReuseHours: 120, titleTriage: false });
  assert.equal(body.expectedVersion, 4);
  assert.deepEqual(body.guidance, { instructions: "", searchTerms: [], employmentScope: ["full_time"] });
  assert.equal(calls[0].path, "/api/greenhouse/guidance");
  await waitFor(() => assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, false));
});

test("invalid conditions show the shared validation message, retain edits and recover", async () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  for (const [label, field, invalid, valid] of [
    [ageLabel, "freshnessDays", "11", "10"], [travelLabel, "travelCapPercent", "101", "0"],
    ["Deferrals count for (hours)", "deferralReuseHours", "721", "1"],
  ] as const) {
    fireEvent.change(view.getByLabelText(label), { target: { value: invalid } });
    fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
    assert.equal(view.getByRole("alert").textContent, greenhousePolicyProblem({ ...defaultGreenhousePullPolicy, [field]: Number(invalid) }));
    assert.equal(calls.length, 0);
    assert.equal((view.getByLabelText(label) as HTMLInputElement).value, invalid);
    fireEvent.change(view.getByLabelText(label), { target: { value: valid } });
    assert.equal(view.queryByRole("alert"), null);
  }
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
});

test("discard restores saved policy, and removing No cap restores the default numeric cap", () => {
  const app = { ...guidanceApp, settings: { ...guidanceApp.settings, greenhousePolicy: { ...defaultGreenhousePullPolicy, freshnessDays: 2, travelCapPercent: null } } };
  const view = guidanceView(async () => {}, app);
  assert.ok(view.getByText("Pull instructions · Saved"));
  fireEvent.click(view.getByRole("checkbox", { name: "No cap" }));
  assert.equal((view.getByLabelText(travelLabel) as HTMLInputElement).value, "5");
  fireEvent.change(view.getByLabelText(ageLabel), { target: { value: "9" } });
  fireEvent.click(view.getByRole("button", { name: "Discard changes" }));
  assert.equal((view.getByLabelText(ageLabel) as HTMLInputElement).value, "2");
  assert.equal((view.getByRole("checkbox", { name: "No cap" }) as HTMLInputElement).checked, true);
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, false);
});

test("regular term transfer validates, saves separately from extra terms and resets to defaults", async () => {
  const { calls, mutate } = mutationRecorder();
  const app = { ...guidanceApp, settings: { ...guidanceApp.settings, greenhousePolicy: { ...defaultGreenhousePullPolicy, regularSearchTerms: ["backend"] }, greenhouseGuidance: { instructions: "Keep focus", searchTerms: ["react"] } } };
  const view = guidanceView(mutate, app);
  fireEvent.click(view.getByRole("button", { name: "Choose regular search terms" }));
  fireEvent.click(view.getByRole("button", { name: "Return backend to pool" }));
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  assert.match(view.getByRole("alert").textContent!, /at least one/);
  fireEvent.change(view.getByLabelText("Custom regular search term"), { target: { value: "BACKEND" } });
  fireEvent.click(view.getByRole("button", { name: "Add to pool" }));
  assert.match(view.getByRole("alert").textContent!, /already in the pool/);
  fireEvent.change(view.getByLabelText("Custom regular search term"), { target: { value: "platform engineer" } });
  fireEvent.submit(view.getByLabelText("Custom regular search term").closest("form")!);
  assert.equal(calls.length, 0);
  fireEvent.click(view.getByRole("button", { name: "Search for platform engineer" }));
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const body = calls[0].body as GreenhouseGuidanceSave;
  assert.deepEqual(body.policy?.regularSearchTerms, ["platform engineer"]);
  assert.deepEqual(body.guidance.searchTerms, ["react"]);
  fireEvent.click(view.getByRole("button", { name: "Reset to defaults" }));
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual((calls[1].body as GreenhouseGuidanceSave).policy?.regularSearchTerms, greenhouseDefaultRegularSearchTerms);
});

test("regular picker supports drag, maximum count, Cancel and focus return without dirtying the draft", () => {
  const terms = Array.from({ length: 16 }, (_, index) => `term ${index}`);
  const view = guidanceView(async () => {}, { ...guidanceApp, settings: { ...guidanceApp.settings, greenhousePolicy: { ...defaultGreenhousePullPolicy, regularSearchTerms: terms } } });
  const trigger = view.getByRole("button", { name: "Choose regular search terms" });
  fireEvent.click(trigger);
  assert.equal((view.getByRole("button", { name: "Search for backend" }) as HTMLButtonElement).disabled, true);
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(view.getByRole("button", { name: "Return term 0 to pool" }).closest("li")!, { dataTransfer });
  fireEvent.drop(view.getByRole("region", { name: "Pool" }), { dataTransfer });
  fireEvent.click(view.getByRole("button", { name: "Search for backend" }));
  assert.ok(view.getByRole("region", { name: "Searching (16/16)" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  assert.equal(document.activeElement, trigger);
  assert.equal((view.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled, true);
});

test("new and running conditions use saved and captured policies independently", () => {
  const view = guidanceView(async () => {}, { ...guidanceApp, greenhousePull: { ...run, policy: captured } });
  assert.ok(view.getByText(`New pull conditions: ${defaultSummary}`));
  assert.ok(view.getByText("Conditions: 3 days · travel uncapped · language rule off · reuse reviews off · title skip off · 1 search term"));
  fireEvent.click(view.getByRole("button", { name: "About conditions" }));
  assert.match(view.getByRole("tooltip").textContent!, /captured when this pull started.*Role keywords to exclude: sales.*Technology exclusions: C#.*Excluded companies: Skipped Co/);
  view.rerender(createElement(OpeningIntake, { state: { ...guidanceApp, settings: { ...guidanceApp.settings, greenhousePolicy: { ...defaultGreenhousePullPolicy, freshnessDays: 1 } }, greenhousePull: { ...run, policy: captured } }, mutate: async () => {}, go: () => {} }));
  assert.ok(view.getByText(/^New pull conditions: 1 day ·/));
  assert.ok(view.getByText(/^Conditions: 3 days/));
});

test("absent and explicitly legacy policies are labelled without inventing a captured default", () => {
  const view = guidanceView(async () => {}, { ...guidanceApp, greenhousePull: run });
  assert.ok(view.getByText("Legacy conditions: No captured policy"));
  fireEvent.click(view.getByRole("button", { name: "About legacy conditions" }));
  assert.match(view.getByRole("tooltip").textContent!, /missing conditions are not inferred/);
  const legacyPolicy = Object.assign({}, captured, { legacy: true });
  view.rerender(createElement(OpeningIntake, { state: { ...guidanceApp, greenhousePull: { ...run, policy: legacyPolicy } }, mutate: async () => {}, go: () => {} }));
  assert.ok(view.getByText(/^Legacy conditions: 3 days/));
  view.rerender(createElement(OpeningIntake, { state: { ...guidanceApp, greenhousePull: { ...run, policy: captured, legacySources: true } }, mutate: async () => {}, go: () => {} }));
  assert.ok(view.getByText(/^Legacy conditions: 3 days/));
});
