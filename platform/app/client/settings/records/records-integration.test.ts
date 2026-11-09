import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor, dom, renderToStaticMarkup } = await import("../../testing/test-render");
const { Settings } = await import("../../pages/Settings");
const { ApplicationDetail } = await import("../../applications/ApplicationDetail");
const { default: SettingsSection } = await import("../SettingsSection");
const { RecordsActivity } = await import("./RecordsActivity");
import { application, state } from "../../testing/component-fixtures";
import { activityEntry, activityPage, catalogPage } from "./records-fixtures";
import { recordsSectionSnapshot } from "../../testing/records-section-snapshot";

const go = () => {};
const mutate = async () => ({});
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

test("Settings combines records and activity behind an unmounted collapsed section and index expands it", async () => {
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.startsWith("/api/records?")) return Response.json(catalogPage);
    if (url.startsWith("/api/activity?")) return Response.json(activityPage);
    if (url === "/api/gmail") return Response.json({ configured: false, connected: false, replies: [] });
    throw Error(`Unexpected request ${url}`);
  };
  const view = render(createElement(Settings, { state, go, mutate, notify: () => {}, maintenance: { disabled: false, rescanning: false, progress: null, onRescan: () => {} } }));
  await waitFor(() => assert.ok(requests.includes("/api/gmail")));
  assert.equal(requests.some(path => /\/api\/(records|activity)/.test(path)), false);
  const section = view.container.querySelector("#settings-records")!;
  const toggle = section.querySelector<HTMLButtonElement>("[data-settings-toggle]")!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.queryByLabelText("Find saved records"), null);
  assert.equal(view.queryByRole("heading", { name: "Activity journal" }), null);
  assert.equal(view.container.querySelector("#settings-saved-records"), null);
  const index = view.getByRole("navigation", { name: "Settings sections" });
  fireEvent.click([...index.querySelectorAll("button")].find(button => button.textContent === "Records & activity")!);
  await view.findByText(catalogPage.rows[0].title);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, section);
  assert.equal(requests.some(path => path.startsWith("/api/activity")), false);
  fireEvent.click(view.getByRole("button", { name: "Activity" }));
  await view.findByText(activityEntry.message);
  assert.equal(view.queryByLabelText("Find saved records"), null);
  fireEvent.click(toggle);
  assert.equal(view.queryByLabelText("Find activity"), null);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("collapsed Settings section has a stable accessible heading and mounts no browser", () => {
  const html = renderToStaticMarkup(createElement(SettingsSection, { id: "settings-records", title: "Records & activity", collapsible: true,
    children: createElement(RecordsActivity, { go }) }));
  assert.equal(html, recordsSectionSnapshot);
});

test("Application History loads lazily from its complete entity scope, paginates, and resets for another application", async () => {
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/follow-up")) return Response.json({ history: [] });
    requests.push(url);
    assert.equal(url.pathname, "/api/activity");
    const next = url.searchParams.has("cursor");
    return Response.json({ ...activityPage, entries: [{ ...activityEntry, id: next ? "older" : "first", message: next ? "Activity before the global feed" : "Application saved" }], nextCursor: next ? undefined : "older" });
  };
  const view = render(createElement(ApplicationDetail, { application, state: { ...state, journal: [] }, go, mutate }));
  assert.equal(requests.length, 0);
  fireEvent.click(view.getByText("History"));
  await view.findByText("Application saved");
  assert.deepEqual(requests[0].searchParams.getAll("entity"), [application.id]);
  fireEvent.click(view.getByRole("button", { name: "Show more history" }));
  await view.findByText("Activity before the global feed");
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), "older");
  view.rerender(createElement(ApplicationDetail, { application: { ...application, id: "another / application" }, state, go, mutate }));
  assert.equal(view.getByText("History").closest("details")!.open, false);
  assert.equal(view.queryByText("Activity before the global feed"), null);
  assert.equal(requests.length, 2);
  fireEvent.click(view.getByText("History"));
  await waitFor(() => assert.deepEqual(requests.at(-1)!.searchParams.getAll("entity"), ["another / application"]));
});

test("Application History refreshes on each expansion and on application changes while open, not unrelated snapshots", async () => {
  let reads = 0;
  let message = "Application created";
  globalThis.fetch = async input => {
    if (String(input).endsWith("/follow-up")) return Response.json({ history: [] });
    reads++;
    return Response.json({ ...activityPage, entries: [{ ...activityEntry, message }], nextCursor: undefined });
  };
  const view = render(createElement(ApplicationDetail, { application, state, go, mutate }));
  fireEvent.click(view.getByText("History"));
  await view.findByText(message);
  assert.equal(reads, 1);
  view.rerender(createElement(ApplicationDetail, { application: { ...application }, state: { ...state }, go, mutate }));
  assert.equal(reads, 1, "an unchanged application in a fresh workspace snapshot does not reload history");
  message = "Application moved to interviewing";
  const updated = { ...application, version: application.version + 1, updatedAt: "2026-10-30T20:10:00Z" };
  view.rerender(createElement(ApplicationDetail, { application: updated, state, go, mutate }));
  await view.findByText(message);
  assert.equal(reads, 2);
  fireEvent.click(view.getByText("History"));
  await waitFor(() => assert.equal(view.container.querySelectorAll(".activity-history").length, 0));
  message = "Submission recorded after closing history";
  const submitted = { ...updated, version: updated.version + 1, updatedAt: "2026-10-30T20:11:00Z", submittedAt: "2026-10-30T20:11:00Z" };
  view.rerender(createElement(ApplicationDetail, { application: submitted, state, go, mutate }));
  assert.equal(reads, 2, "a closed history stays lazy");
  fireEvent.click(view.getByText("History"));
  await view.findByText(message);
  assert.equal(reads, 3);
  fireEvent.click(view.getByText("History"));
  await waitFor(() => assert.equal(view.container.querySelectorAll(".activity-history").length, 0));
  message = "Latest application activity";
  fireEvent.click(view.getByText("History"));
  await view.findByText(message);
  assert.equal(reads, 4, "reopening reloads even without an application version change");
});

test("Application History retries errors instead of treating them as empty history", async () => {
  let fail = true;
  globalThis.fetch = async input => {
    if (String(input).endsWith("/follow-up")) return Response.json({ history: [] });
    return fail ? Response.json({ error: "History unavailable" }, { status: 503 })
      : Response.json({ ...activityPage, entries: [], total: 0, nextCursor: undefined });
  };
  const view = render(createElement(ApplicationDetail, { application, state, go, mutate }));
  fireEvent.click(view.getByText("History"));
  await view.findByText("History unavailable");
  assert.equal(view.queryByText("No activity saved for this application."), null);
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Retry history" }));
  await view.findByText("No activity saved for this application.");
});
