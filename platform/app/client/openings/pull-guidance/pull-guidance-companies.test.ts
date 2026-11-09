import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreenhousePullPolicy } from "../../../shared/greenhouse-policy";
const { fireEvent, waitFor, mutationRecorder, createElement } = await import("../../testing/test-render");
const { default: OpeningIntake } = await import("../OpeningIntake");
const { guidanceView, companyApp } = await import("./guidance-test-fixture");
import { greenhouseCompanyFilterLimits } from "../../../shared/greenhouse-company-filter";
import type { GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";

function row(button: HTMLElement) { return button.closest("li")!; }

test("company chooser merges variants, sorts visible counts, and includes hidden Openings only on request", () => {
  const view = guidanceView(async () => {}, companyApp);
  fireEvent.click(view.getByRole("button", { name: "Choose companies" }));
  const acme = view.getByRole("button", { name: "Exclude Acme, Inc." });
  assert.match(row(acme).textContent!, /3 Openings/);
  assert.equal(view.queryByRole("button", { name: "Exclude ACMÉ INC" }), null);
  assert.equal(view.queryByRole("button", { name: "Exclude Closed Co" }), null);
  assert.equal(view.queryByRole("button", { name: "Exclude History Co" }), null);
  assert.match(row(view.getByRole("button", { name: "Include No openings" })).textContent!, /0 Openings/);
  assert.match(row(view.getByRole("button", { name: "Include board-token" })).textContent!, /1 Opening\b/);
  assert.equal(view.queryByRole("button", { name: "Exclude Board Company" }), null);
  assert.equal(acme.closest("ul")?.firstElementChild, row(acme));
  fireEvent.click(view.getByRole("checkbox", { name: "Include archived" }));
  assert.match(row(acme).textContent!, /4 Openings/);
  assert.match(row(view.getByRole("button", { name: "Exclude Closed Co" })).textContent!, /1 Opening\b/);
  assert.match(row(view.getByRole("button", { name: "Exclude History Co" })).textContent!, /1 Opening\b/);
  fireEvent.change(view.getByLabelText("Filter companies"), { target: { value: "history" } });
  assert.equal(view.queryByRole("button", { name: "Exclude Acme, Inc." }), null);
  assert.ok(view.getByRole("button", { name: "Exclude History Co" }));
  assert.ok(view.getByRole("button", { name: "Include No openings" }));
});

test("company moves and manual names are draft-only until Apply and one combined Save", async () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate, companyApp);
  fireEvent.click(view.getByRole("button", { name: "Choose companies" }));
  fireEvent.click(view.getByRole("button", { name: "Exclude Acme, Inc." }));
  assert.ok(view.getByRole("button", { name: "Include Acme, Inc." }));
  fireEvent.click(view.getByRole("button", { name: "Include No openings" }));
  const input = view.getByLabelText("Company name or Greenhouse board token");
  fireEvent.change(input, { target: { value: "acme inc" } });
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  assert.match(view.getByRole("alert").textContent!, /already excluded/);
  fireEvent.change(input, { target: { value: "new-board" } });
  fireEvent.submit(input.closest("form")!);
  assert.equal(calls.length, 0, "popup form must not submit the guidance form");
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0].body, { expectedVersion: 4, guidance: { instructions: "", searchTerms: [], employmentScope: ["full_time"] }, excludedCompanies: ["board-token", "Acme, Inc.", "new-board"], searchTermPool: [], policy: defaultGreenhousePullPolicy } satisfies GreenhouseGuidanceSave);
});

test("company drag works both ways and Cancel discards all modal changes", () => {
  const view = guidanceView(async () => {}, companyApp);
  fireEvent.click(view.getByRole("button", { name: "Choose companies" }));
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(row(view.getByRole("button", { name: "Exclude Acme, Inc." })), { dataTransfer });
  fireEvent.dragOver(view.getByRole("region", { name: "Excluded (2)" }), { dataTransfer });
  fireEvent.drop(view.getByRole("region", { name: "Excluded (2)" }), { dataTransfer });
  fireEvent.dragStart(row(view.getByRole("button", { name: "Include Acme, Inc." })), { dataTransfer });
  fireEvent.drop(view.getByRole("region", { name: "Companies" }), { dataTransfer });
  assert.ok(view.getByRole("button", { name: "Exclude Acme, Inc." }));
  fireEvent.click(view.getByRole("button", { name: "Include board-token" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  assert.equal(document.activeElement, view.getByRole("button", { name: "Choose companies" }));
  assert.equal((view.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Choose companies" }));
  assert.ok(view.getByRole("button", { name: "Include board-token" }));
});

test("a popup captures the settings version on open and enforces the exclusion cap", async () => {
  const { calls, mutate } = mutationRecorder();
  const app = { ...companyApp, settings: { ...companyApp.settings, greenhouseExcludedCompanies: Array.from({ length: greenhouseCompanyFilterLimits.count }, (_, i) => `Company ${i}`) } };
  const view = guidanceView(mutate, app);
  fireEvent.click(view.getByRole("button", { name: "Choose companies" }));
  assert.equal((view.getByRole("button", { name: "Exclude Acme, Inc." }) as HTMLButtonElement).disabled, true);
  fireEvent.change(view.getByLabelText("Company name or Greenhouse board token"), { target: { value: "Beyond limit" } });
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  assert.match(view.getByRole("alert").textContent!, /up to 100/);
  view.rerender(createElement(OpeningIntake, { state: { ...app, settings: { ...app.settings, version: 5 } }, mutate, go: () => {} }));
  fireEvent.click(view.getByRole("button", { name: "Include Company 0" }));
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal((calls[0].body as GreenhouseGuidanceSave).expectedVersion, 4);
});
