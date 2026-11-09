import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
const { createElement, render, cleanup, fireEvent } = await import("../testing/test-render");
const { Applications } = await import("../pages/Applications");
import { application, opening, state } from "../testing/component-fixtures";
import type { ApplicationStatus } from "../../shared/types";

const stages: ApplicationStatus[] = ["considering", "applied", "interviewing", "offer", "rejected"];
const fixture = {
  ...state,
  applications: stages.map(status => ({ ...application, id: status, openingId: status, status })),
  openings: stages.map(status => ({ ...opening, id: status, company: status, title: `${status} role` })),
};
const props = { state: fixture, selected: "", go: () => {}, mutate: async () => ({}), agent: () => {}, notify: () => {} };
const rows = (container: HTMLElement) => [...container.querySelectorAll("[data-application-id]")].map(row => row.getAttribute("data-application-id"));
beforeEach(() => localStorage.clear());

test("Rejected follows Interviewing, selects only rejections, and stays selected after remount", () => {
  localStorage.setItem("fieldwork.applications.showRejected", "true");
  let view = render(createElement(Applications, props));
  assert.equal(view.queryByRole("checkbox", { name: /Show rejected/ }), null);
  assert.deepEqual(rows(view.container).sort(), ["applied", "considering", "interviewing", "offer"]);
  const buttons = [...view.getByRole("group", { name: "Application stage" }).querySelectorAll("button")];
  assert.match(buttons.at(-2)!.textContent!, /^Interviewing 1$/);
  assert.match(buttons.at(-1)!.textContent!, /^Rejected 1$/);
  fireEvent.click(view.getByRole("button", { name: "Rejected 1" }));
  assert.deepEqual(rows(view.container), ["rejected"]);
  assert.equal(view.getByRole("button", { name: "Rejected 1" }).getAttribute("aria-pressed"), "true");
  assert.ok(view.getByRole("link", { name: "rejected rejected role" }).getAttribute("href")?.endsWith("applications/rejected"));
  cleanup();
  view = render(createElement(Applications, props));
  assert.deepEqual(rows(view.container), ["rejected"]);
  fireEvent.click(view.getByRole("button", { name: "Applied 1" }));
  assert.deepEqual(rows(view.container), ["applied"]);
  fireEvent.click(view.getByRole("button", { name: "All applications 4" }));
  assert.deepEqual(rows(view.container).sort(), ["applied", "considering", "interviewing", "offer"]);
});

test("Board uses the same stage selector and retains the full active pipeline under All", () => {
  const view = render(createElement(Applications, props));
  fireEvent.click(view.getByRole("button", { name: "Board" }));
  assert.equal(view.queryByRole("heading", { name: "Rejected 1" }), null);
  assert.ok(view.getByRole("heading", { name: "Applied 1" }));
  fireEvent.click(view.getByRole("button", { name: "Rejected 1" }));
  assert.ok(view.getByRole("heading", { name: "Rejected 1" }));
  assert.equal(view.queryByRole("heading", { name: "Applied 1" }), null);
  assert.equal(view.container.querySelectorAll(".kanban-card").length, 1);
  fireEvent.click(view.getByRole("button", { name: "All applications 4" }));
  assert.ok(view.getByRole("heading", { name: "Applied 1" }));
  assert.equal(view.container.querySelectorAll(".kanban-card").length, 4);
});

test("A direct link still opens a rejected application while All hides its row", () => {
  const view = render(createElement(Applications, { ...props, selected: "rejected" }));
  assert.equal(rows(view.container).includes("rejected"), false);
  assert.ok(view.getByRole("heading", { name: "rejected role" }));
  assert.equal((view.getByRole("combobox", { name: "Application stage" }) as HTMLSelectElement).value, "rejected");
});
