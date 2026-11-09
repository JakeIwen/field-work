import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render } = await import("../testing/test-render");
const { NavigationCount } = await import("./NavigationCount");
import { application, opening, state } from "../testing/component-fixtures";
import type { ApplicationStatus } from "../../shared/types";

test("Applications badge counts only applied and interviewing, including when other stages exist", () => {
  const statuses: ApplicationStatus[] = ["considering", "preparing", "ready", "applied", "applied", "interviewing", "offer", "rejected", "withdrawn"];
  const fixture = { ...state, applications: statuses.map((status, index) => ({ ...application, status, id: String(index) })) };
  const view = render(createElement(NavigationCount, { id: "applications", state: fixture }));
  assert.equal(view.getByTitle("Applied and interviewing applications").textContent, "3");
});

test("Openings badge starts from visible openings and uses the current filtered count even when zero", () => {
  const fixture = {
    ...state,
    openings: [
      { ...opening, id: "first", url: "https://job-boards.greenhouse.io/fixture/jobs/1" },
      { ...opening, id: "second", url: "https://job-boards.greenhouse.io/fixture/jobs/2" },
      { ...opening, id: "dismissed", url: "https://job-boards.greenhouse.io/fixture/jobs/3" },
      { ...opening, id: "closed", url: "https://job-boards.greenhouse.io/fixture/jobs/4", postingStatus: "closed" },
      { ...opening, id: "applied", url: "https://job-boards.greenhouse.io/fixture/jobs/5" },
      { ...opening, id: "history", url: "https://job-boards.greenhouse.io/fixture/jobs/6", retained: false },
    ],
    personal: { dismissed: { dismissed: true, version: 1 } },
    applications: [{ ...application, openingId: "applied", status: "applied" as const }],
  };
  const view = render(createElement(NavigationCount, { id: "openings", state: fixture }));
  assert.equal(view.getByTitle("Openings in the current view").textContent, "2");
  view.rerender(createElement(NavigationCount, { id: "openings", state: fixture, visibleOpeningCount: 1 }));
  assert.equal(view.getByTitle("Openings in the current view").textContent, "1");
  view.rerender(createElement(NavigationCount, { id: "openings", state: fixture, visibleOpeningCount: 0 }));
  assert.equal(view.getByTitle("Openings in the current view").textContent, "0");
});
