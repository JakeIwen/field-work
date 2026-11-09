import type { AppState } from "../../../shared/types";
import type { Mutate } from "../../workspace/workspace-actions";
import { opening, state } from "../../testing/component-fixtures";
const { dom, createElement, render, fireEvent } = await import("../../testing/test-render");
const { default: OpeningIntake } = await import("../OpeningIntake");

// jsdom has no native modal lifecycle; exercise the component's native API calls.
dom.window.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); this.querySelector<HTMLButtonElement>("button")?.focus(); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

export const guidanceApp: AppState = {
  ...state, tasks: [], applications: [], greenhousePull: null,
  settings: { timezone: "America/Denver", version: 4 },
};
export function guidanceView(mutate: Mutate, app = guidanceApp) {
  return render(createElement(OpeningIntake, { state: app, mutate, go: () => {} }));
}
export function chooseTerms(view: ReturnType<typeof guidanceView>, terms: string[]) {
  fireEvent.click(view.getByRole("button", { name: "Choose search terms" }));
  for (const term of terms) fireEvent.click(view.getByRole("button", { name: `Search for ${term}` }));
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
}
export const companyApp: AppState = {
  ...guidanceApp,
  settings: { ...guidanceApp.settings, greenhouseExcludedCompanies: ["No openings", "board-token"] },
  personal: { dismissed: { dismissed: true, version: 1 } },
  openings: [
    { ...opening, id: "a", company: "Acme, Inc." },
    { ...opening, id: "b", company: "Acme, Inc." },
    { ...opening, id: "c", company: "ACMÉ INC" },
    { ...opening, id: "dismissed", company: "Acme, Inc." },
    { ...opening, id: "closed", company: "Closed Co", postingStatus: "closed" },
    { ...opening, id: "history", company: "History Co", retained: false },
    { ...opening, id: "token", company: "Board Company", url: "https://job-boards.greenhouse.io/board-token/jobs/123" },
    { ...opening, id: "other", company: "Another Co" },
  ],
};
