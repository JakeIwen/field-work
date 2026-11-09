import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../testing/test-render");
const { default: PreparationSettings } = await import("./PreparationSettings");
import { state } from "../testing/component-fixtures";
import type { AppState } from "../../shared/types";
import type { Mutate } from "../workspace/workspace-actions";
import { preparationSettingsPath } from "../../shared/preparation-settings";

test("Generate Docs defaults to eight preparations with bounded input, outlined Save and tooltip-only help", () => {
  const view = render(createElement(PreparationSettings, { state, mutate: async () => {}, notify: () => {} }));
  const input = view.getByLabelText("Parallel preparations") as HTMLInputElement;
  assert.equal(input.value, "8");
  assert.equal(input.min, "1"); assert.equal(input.max, "12"); assert.equal(input.step, "1");
  assert.ok(view.getByRole("form", { name: "Generate Docs settings" }));
  assert.equal(view.getByRole("heading", { name: "Generate Docs" }).textContent, "Generate Docs");
  const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  assert.ok(save.classList.contains("primary")); assert.ok(save.disabled);
  assert.equal(view.queryByRole("tooltip"), null);
  const help = view.getByRole("button", { name: "About parallel preparations" });
  assert.equal(help.closest("h2"), null);
  fireEvent.click(help);
  assert.match(view.getByRole("tooltip").textContent!, /lowering it never interrupts running preparations/);
});

test("preparation form blocks out-of-range and non-integer values without saving", () => {
  let calls = 0;
  const view = render(createElement(PreparationSettings, { state, mutate: async () => { calls++; }, notify: () => {} }));
  const input = view.getByLabelText("Parallel preparations") as HTMLInputElement;
  for (const value of ["0", "13", "1.5", ""]) {
    fireEvent.change(input, { target: { value } });
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(view.getByRole("alert").textContent, "Enter a whole number from 1 to 12.");
    assert.equal((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
    fireEvent.submit(input.closest("form")!);
  }
  assert.equal(calls, 0);
});

test("preparation save keeps failed edits and their version; Use current value adopts remote changes before retry", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const notices: string[] = [];
  let fail = true;
  const mutate: Mutate = async (path, body) => { calls.push({ path, body }); if (fail) throw Error("Settings changed"); };
  const app: AppState = { ...state, settings: { timezone: "America/Denver", version: 4 } };
  const props = { state: app, mutate, notify: (message: string) => { notices.push(message); } };
  const view = render(createElement(PreparationSettings, props));
  const input = view.getByLabelText("Parallel preparations") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "2" } });
  const changed = { ...app, settings: { ...app.settings, version: 5, parallelPreparations: 10 } };
  view.rerender(createElement(PreparationSettings, { ...props, state: changed }));
  assert.equal(input.value, "2");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Settings changed/));
  assert.deepEqual(calls[0], { path: preparationSettingsPath, body: { expectedVersion: 4, parallelPreparations: 2 } });
  assert.equal(input.value, "2");
  assert.deepEqual(notices, []);
  fireEvent.click(view.getByRole("button", { name: "Use current value" }));
  assert.equal(input.value, "10"); assert.equal(view.queryByRole("alert"), null);
  fireEvent.change(input, { target: { value: "12" } });
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.deepEqual(notices, ["Generate Docs settings saved"]));
  assert.deepEqual(calls[1], { path: preparationSettingsPath, body: { expectedVersion: 5, parallelPreparations: 12 } });
  view.rerender(createElement(PreparationSettings, { ...props, state: { ...app, settings: { ...app.settings, version: 6, parallelPreparations: 12 } } }));
  assert.equal(input.value, "12");
  assert.equal((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);
});
