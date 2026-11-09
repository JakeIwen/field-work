import assert from "node:assert/strict";
import test from "node:test";
import { defaultGreenhousePullPolicy } from "../../../shared/greenhouse-policy";
const { fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { guidanceView, guidanceApp } = await import("./guidance-test-fixture");
import { greenhouseGuidanceLimits, greenhouseSearchTermPoolLimit, greenhouseSuggestedSearchTerms, type GreenhouseGuidanceSave } from "../../../shared/greenhouse-guidance";

test("custom terms are added to the pool, deduped, moved and saved with all guidance in one request", async () => {
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  assert.equal(view.queryByRole("button", { name: "Delete custom term react" }), null);
  const input = view.getByLabelText(/Custom search term/);
  fireEvent.change(input, { target: { value: "REACT" } });
  fireEvent.click(view.getByRole("button", { name: "Add to pool" }));
  assert.match(view.getByRole("alert").textContent!, /already in the pool/);
  fireEvent.change(input, { target: { value: " fractional developer " } });
  fireEvent.submit(input.closest("form")!);
  assert.equal(calls.length, 0);
  assert.ok(view.getByRole("button", { name: "Delete custom term fractional developer" }));
  fireEvent.click(view.getByRole("button", { name: "Search for fractional developer" }));
  fireEvent.click(view.getByRole("button", { name: "Search for node.js" }));
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Contract" }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0].body, { expectedVersion: 4, guidance: { instructions: "", searchTerms: ["fractional developer", "node.js"], employmentScope: ["full_time", "contract"] }, excludedCompanies: [], searchTermPool: ["fractional developer"], policy: defaultGreenhousePullPolicy } satisfies GreenhouseGuidanceSave);
});

test("the active search cap blocks moves, and a removed legacy active term returns to the custom pool", async () => {
  const { calls, mutate } = mutationRecorder();
  const terms = [...greenhouseSuggestedSearchTerms.slice(0, greenhouseGuidanceLimits.searchTerms - 1), "legacy fractional"];
  const app = { ...guidanceApp, settings: { ...guidanceApp.settings, greenhouseGuidance: { instructions: "", searchTerms: terms } } };
  const view = guidanceView(mutate, app);
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  const angular = view.getByRole("button", { name: "Search for angular" }) as HTMLButtonElement;
  assert.equal(angular.disabled, true);
  assert.ok(view.getByText("Searching (8/8)"));
  fireEvent.click(view.getByRole("button", { name: "Return legacy fractional to pool" }));
  assert.equal(angular.disabled, false);
  assert.ok(view.getByRole("button", { name: "Delete custom term legacy fractional" }));
  fireEvent.click(angular);
  assert.equal((view.getByRole("button", { name: "Search for legacy fractional" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  fireEvent.click(view.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const body = calls[0].body as GreenhouseGuidanceSave;
  assert.deepEqual(body.searchTermPool, ["legacy fractional"]);
  assert.equal(body.guidance.searchTerms.length, 8);
  assert.ok(body.guidance.searchTerms.includes("angular"));
});

test("custom pool limits cannot silently discard legacy active terms, and custom deletion makes room", () => {
  const app = { ...guidanceApp, settings: { ...guidanceApp.settings,
    greenhouseGuidance: { instructions: "", searchTerms: ["legacy"] },
    greenhouseSearchTermPool: Array.from({ length: greenhouseSearchTermPoolLimit }, (_, index) => `Custom ${index}`),
  } };
  const view = guidanceView(async () => {}, app);
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  fireEvent.change(view.getByLabelText(/Custom search term/), { target: { value: "Beyond limit" } });
  fireEvent.click(view.getByRole("button", { name: "Add to pool" }));
  assert.match(view.getByRole("alert").textContent!, /limited to 40/);
  fireEvent.click(view.getByRole("button", { name: "Return legacy to pool" }));
  assert.match(view.getByRole("alert").textContent!, /Delete a custom pool term/);
  assert.ok(view.getByText("Searching (1/8)"));
  fireEvent.click(view.getByRole("button", { name: "Delete custom term Custom 0" }));
  fireEvent.click(view.getByRole("button", { name: "Return legacy to pool" }));
  assert.ok(view.getByText("Searching (0/8)"));
  assert.ok(view.getByRole("button", { name: "Search for legacy" }));
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  assert.ok(view.getByRole("button", { name: "Return legacy to pool" }));
  assert.ok(view.getByRole("button", { name: "Delete custom term Custom 0" }));
  assert.equal((view.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled, true);
});

test("search terms can be dragged into and out of Searching", () => {
  const view = guidanceView(async () => {});
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(view.getByRole("button", { name: "Search for react" }).closest("li")!, { dataTransfer });
  fireEvent.drop(view.getByRole("region", { name: "Searching (0/8)" }), { dataTransfer });
  fireEvent.dragStart(view.getByRole("button", { name: "Return react to pool" }).closest("li")!, { dataTransfer });
  fireEvent.drop(view.getByRole("region", { name: "Pool" }), { dataTransfer });
  assert.ok(view.getByRole("button", { name: "Search for react" }));
  assert.ok(view.getByText("Searching (0/8)"));
});
