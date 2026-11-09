import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AppState } from "../../shared/types";
import { opening, state } from "../testing/component-fixtures";
import { openingSortStorageKey } from "./opening-sort";
const { createElement, render, fireEvent, waitFor, mutationRecorder } = await import("../testing/test-render");
const { emptyOpeningFilters, filterOpenings, normalizeOpeningFilters } = await import("./opening-filters");
const { Openings } = await import("../pages/Openings");
afterEach(() => localStorage.clear());

const openings = [
  { ...opening, id: "high", technical_fit: "High", remote_fit: "High", wlb_outlook: "Low" },
  { ...opening, id: "medium", technical_fit: "Medium", remote_fit: "Low", wlb_outlook: "Medium" },
  { ...opening, id: "unknown", technical_fit: "Unknown", remote_fit: "Uncertain", wlb_outlook: "Unknown" },
].map((item, index) => ({ ...item, url: `https://job-boards.greenhouse.io/example/jobs/${index + 100}` }));
const appState: AppState = {
  ...state, openings, applications: [], tasks: [],
  personal: { medium: { reviewedHash: "old-hash", version: 1 }, unknown: { reviewedHash: opening.hash, version: 1 } },
};
const ids = (filters: typeof emptyOpeningFilters) => filterOpenings(appState, filters).map(item => item.id);

test("legacy single-string saved filters become arrays; empty or absent values remain any", () => {
  const filters = normalizeOpeningFilters({ technical: "High", remote: "Medium", wlb: "Uncertain", review: "changed", pay: "150000", priority: "A" });
  assert.deepEqual([filters.technical, filters.remote, filters.wlb, filters.review], [["High"], ["Medium"], ["Uncertain"], ["changed"]]);
  assert.equal(filters.pay, "150000");
  assert.equal("priority" in filters, false, "the retired Priority filter is dropped");
  assert.deepEqual(normalizeOpeningFilters({ technical: "", remote: "", wlb: "", review: "" }), emptyOpeningFilters);
  assert.deepEqual(normalizeOpeningFilters({}), emptyOpeningFilters);
});

test("saved arrays normalize duplicates and invalid values without mutating the saved record", () => {
  const saved = { technical: ["Medium", "High", "Medium", "bogus", 4], remote: null, wlb: {}, review: ["changed", "unreviewed", "bad"] };
  const original = structuredClone(saved);
  const filters = normalizeOpeningFilters(saved);
  assert.deepEqual(filters.technical, ["High", "Medium"]);
  assert.deepEqual(filters.remote, []);
  assert.deepEqual(filters.wlb, []);
  assert.deepEqual(filters.review, ["unreviewed", "changed"]);
  assert.deepEqual(saved, original);
});

test("assessment selections OR within each dropdown, AND between dropdowns, and empty matches any", () => {
  assert.deepEqual(ids(emptyOpeningFilters), ["high", "medium", "unknown"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, technical: ["High", "Medium"] }), ["high", "medium"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, remote: ["High", "Uncertain"] }), ["high", "unknown"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, wlb: ["Medium", "Unknown"] }), ["medium", "unknown"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, technical: ["High", "Medium"], remote: ["High"], wlb: ["Low", "Medium"] }), ["high"]);
  assert.deepEqual(ids(normalizeOpeningFilters({ technical: "High" })), ["high"]);
});

test("review selections include either unreviewed or changed records, not current reviews", () => {
  assert.deepEqual(ids({ ...emptyOpeningFilters, review: ["unreviewed"] }), ["high"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, review: ["changed"] }), ["medium"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, review: ["unreviewed", "changed"] }), ["high", "medium"]);
  assert.deepEqual(ids({ ...emptyOpeningFilters, review: ["unreviewed", "changed"], technical: ["Medium"] }), ["medium"]);
});

test("Openings loads legacy filters, saves array selections, reloads them and Reset restores any", async () => {
  const { calls, mutate } = mutationRecorder();
  const counts: number[] = [];
  const props = { state: { ...appState, savedFilters: [{ id: "legacy", name: "Legacy filter", filters: { technical: "High", review: "", sort: "newest" }, version: 1 }] },
    selected: "", go: () => {}, personal: async () => ({}), mutate, onVisibleCountChange: (count: number) => counts.push(count) };
  const view = render(createElement(Openings, props));
  fireEvent.change(view.getByLabelText("Load saved filter"), { target: { value: "legacy" } });
  assert.equal(view.getByRole("button", { name: "Technical fit" }).textContent, "High");
  assert.equal(view.getByRole("button", { name: "My review" }).textContent, "Any review state");
  assert.equal(counts.at(-1), 1);
  fireEvent.click(view.getByText("More filters", { selector: "summary" }));
  fireEvent.click(view.getByRole("button", { name: "Technical fit" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Medium" }));
  fireEvent.keyDown(view.getByRole("checkbox", { name: "Medium" }), { key: "Escape" });
  assert.equal(counts.at(-1), 2);
  fireEvent.click(view.getByRole("button", { name: "Save filter" }));
  fireEvent.change(view.getByLabelText("Filter name"), { target: { value: "Two ratings" } });
  fireEvent.submit(view.getByLabelText("Filter name").closest("form")!);
  await waitFor(() => assert.equal(calls.length, 1));
  const body = calls[0].body as { name: string; filters: typeof emptyOpeningFilters };
  assert.equal(calls[0].path, "/api/filters");
  assert.deepEqual(body.filters.technical, ["High", "Medium"]);
  view.rerender(createElement(Openings, { ...props, state: { ...appState, savedFilters: [{ id: "new", name: body.name, filters: body.filters, version: 1 }] } }));
  fireEvent.click(view.getByRole("button", { name: "Reset" }));
  assert.equal(counts.at(-1), 3);
  fireEvent.change(view.getByLabelText("Load saved filter"), { target: { value: "new" } });
  assert.equal(view.getByRole("button", { name: "Technical fit" }).textContent, "High, Medium");
  assert.equal(counts.at(-1), 2);
  assert.equal((view.getByRole("combobox", { name: "Sort opportunities" }) as HTMLSelectElement).value, "newest");
  assert.equal(localStorage.getItem(openingSortStorageKey), "newest");
});
