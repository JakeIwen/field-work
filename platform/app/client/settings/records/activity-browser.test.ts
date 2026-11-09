import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor, dom } = await import("../../testing/test-render");
const { ActivityBrowser } = await import("./ActivityBrowser");
const { setCsrf } = await import("../../workspace/api");
import { activityEntry, activityError, activityPage } from "./records-fixtures";
import { journalDeletionMaxIds } from "../../../shared/activity";

const go = () => {};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

test("activity shows workflow, severity, entity and details and requests server filters", async () => {
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    return Response.json(url.searchParams.has("cursor") ? { ...activityPage, entries: [{ ...activityEntry, id: "older", message: "Older event" }], nextCursor: undefined } : activityPage);
  };
  const view = render(createElement(ActivityBrowser, { go }));
  await view.findByText(activityEntry.message);
  assert.ok(view.getByText("Warning").classList.contains("amber"));
  assert.ok(view.getByText("Error").classList.contains("red"));
  assert.ok(view.getByRole("option", { name: "Generate Docs (2)" }));
  assert.equal(view.getAllByRole("link")[0].getAttribute("href"), "#applications/app%20%2F%20fixture");
  const details = view.getAllByText("Details")[0].closest("details")!;
  assert.equal(details.open, false);
  fireEvent.click(details.querySelector("summary")!);
  assert.ok(view.getAllByText(activityEntry.details!));
  fireEvent.click(view.getByRole("button", { name: "Show more activity" }));
  await view.findByText("Older event");
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), "older / activity");
  fireEvent.change(view.getByLabelText("Activity level"), { target: { value: "warning" } });
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("level"), "warning"));
  fireEvent.change(view.getByLabelText("Workflow"), { target: { value: "Generate Docs" } });
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("workflow"), "Generate Docs"));
  fireEvent.change(view.getByLabelText("Activity level"), { target: { value: "error" } });
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("level"), "error"));
  const before = requests.length;
  fireEvent.change(view.getByLabelText("Find activity"), { target: { value: "Evidence" } });
  assert.equal(requests.length, before);
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("q"), "Evidence"));
  assert.equal(requests.at(-1)!.searchParams.has("cursor"), false);
});

test("activity requests the saved page size", async () => {
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    return Response.json(activityPage);
  };
  const view = render(createElement(ActivityBrowser, { go, pageSize: 25 }));
  await view.findByText(activityEntry.message);
  assert.equal(requests[0].searchParams.get("limit"), "25");
});

test("activity cleanup confirms exact ids, preserves rows on failure and refreshes rows and counts after retry", async () => {
  let fail = true;
  let deleted = false;
  let reads = 0;
  const originalScroll = window.scrollTo;
  window.scrollTo = () => {};
  const bodies: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/activity?")) {
      reads++;
      return Response.json(deleted ? { ...activityPage, total: 4, entries: [{ ...activityEntry, id: "new", message: "New activity after cleanup" }],
        counts: { ...activityPage.counts, workflow: { "Generate Docs": 4 } } } : activityPage);
    }
    assert.equal(String(input), "/api/journal");
    assert.equal(init?.method, "DELETE");
    bodies.push(JSON.parse(String(init?.body)));
    if (fail) return Response.json({ error: "Delete unavailable" }, { status: 503 });
    deleted = true;
    return Response.json({ deleted: 1, missing: 1 });
  };
  setCsrf("fixture");
  try {
    const view = render(createElement(ActivityBrowser, { go }));
    await view.findByText(activityEntry.message);
    fireEvent.click(view.getByRole("button", { name: "Select shown" }));
    fireEvent.click(view.getByRole("button", { name: "Delete selected (2)" }));
    assert.ok(view.getByRole("dialog", { name: "Delete selected activity" }).hasAttribute("open"));
    assert.equal(bodies.length, 0);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    assert.equal(view.queryByRole("dialog"), null);
    fireEvent.click(view.getByRole("button", { name: "Delete selected (2)" }));
    fireEvent.click(view.getByRole("button", { name: "Permanently delete activity" }));
    await view.findByRole("alert");
    assert.ok(view.getByText(activityEntry.message));
    fail = false;
    fireEvent.click(view.getByRole("button", { name: "Permanently delete activity" }));
    await view.findByText("Deleted 1 activity entry. 1 already removed.");
    await view.findByText("New activity after cleanup");
    assert.deepEqual(bodies, [{ ids: [activityEntry.id, activityError.id] }, { ids: [activityEntry.id, activityError.id] }]);
    assert.equal(view.queryByText(activityEntry.message), null);
    assert.equal(view.queryByText(activityError.message), null);
    assert.equal(reads, 2);
    assert.ok(view.getByRole("option", { name: "Generate Docs (4)" }));
    assert.ok(view.getByText("4 activity entries · 1 shown"));
  } finally { setCsrf(""); window.scrollTo = originalScroll; }
});

test("changing activity filters clears selection rather than deleting hidden entries", async () => {
  globalThis.fetch = async () => Response.json(activityPage);
  const view = render(createElement(ActivityBrowser, { go }));
  await view.findByText(activityEntry.message);
  fireEvent.click(view.getByLabelText(`Select activity: ${activityEntry.message}`));
  assert.ok(view.getByRole("button", { name: "Delete selected (1)" }));
  fireEvent.change(view.getByLabelText("Activity level"), { target: { value: "error" } });
  await view.findByRole("button", { name: "Delete selected (0)" });
  assert.equal((view.getByLabelText(`Select activity: ${activityEntry.message}`) as HTMLInputElement).checked, false);
});

test("select shown respects the deletion bound across loaded pages", async () => {
  globalThis.fetch = async input => {
    const cursor = new URL(String(input), "http://localhost").searchParams.get("cursor");
    const start = Number(cursor || 0);
    const entries = Array.from({ length: 100 }, (_, i) => ({ ...activityEntry, id: `entry-${start + i}`, message: `Event ${start + i}` }));
    return Response.json({ ...activityPage, entries, total: 600, nextCursor: start < 500 ? String(start + 100) : undefined });
  };
  const view = render(createElement(ActivityBrowser, { go }));
  await view.findByText("Event 0");
  for (let page = 1; page < 6; page++) {
    fireEvent.click(view.getByRole("button", { name: "Show more activity" }));
    await view.findByText(`Event ${page * 100}`);
  }
  fireEvent.click(view.getByRole("button", { name: "Select shown" }));
  assert.equal(view.getAllByRole("checkbox").filter(input => (input as HTMLInputElement).checked).length, journalDeletionMaxIds);
  assert.ok(view.getByText(`Up to ${journalDeletionMaxIds} entries can be archived or deleted at once.`));
  fireEvent.click(view.getByLabelText("Select activity: Event 599"));
  assert.ok(view.getByRole("button", { name: `Delete selected (${journalDeletionMaxIds})` }));
  fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
  assert.equal(view.getAllByRole("checkbox").some(input => (input as HTMLInputElement).checked), false);
});

test("activity failure is retryable and an empty result stays explicit", async () => {
  let fail = true;
  globalThis.fetch = async () => fail ? Response.json({ error: "Activity unavailable" }, { status: 503 }) : Response.json({ ...activityPage, entries: [], total: 0, nextCursor: undefined });
  const view = render(createElement(ActivityBrowser, { go }));
  await view.findByRole("alert");
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Retry activity" }));
  await view.findByText("No activity matches these filters.");
  assert.equal(view.queryByRole("alert"), null);
});

test("archiving hides entries with the row X or in bulk, can be undone, and the archived view restores them", async () => {
  const archived = new Set<string>();
  const bodies: unknown[] = [];
  const reads: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/activity") {
      reads.push(url);
      const scope = url.searchParams.get("archived") ?? "active";
      const entries = activityPage.entries.map(entry => archived.has(entry.id) ? { ...entry, archivedAt: "2026-10-30T02:00:00Z" } : entry)
        .filter(entry => scope === "all" || (scope === "archived") === Boolean(entry.archivedAt));
      return Response.json({ ...activityPage, entries, total: entries.length, nextCursor: undefined });
    }
    assert.equal(url.pathname, "/api/journal/archive");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { ids: string[]; archived: boolean };
    bodies.push(body);
    for (const id of body.ids) if (body.archived) archived.add(id); else archived.delete(id);
    return Response.json({ updated: body.ids.length, missing: 0 });
  };
  setCsrf("fixture");
  try {
    const view = render(createElement(ActivityBrowser, { go }));
    await view.findByText(activityEntry.message);
    fireEvent.click(view.getByRole("button", { name: `Archive activity: ${activityEntry.message}` }));
    await view.findByText("Archived 1 activity entry.");
    await waitFor(() => assert.equal(view.queryByText(activityEntry.message), null));
    fireEvent.click(view.getByRole("button", { name: "Undo" }));
    await view.findByText("Restored 1 activity entry.");
    await view.findByText(activityEntry.message);
    assert.equal(view.queryByRole("button", { name: "Undo" }), null);

    fireEvent.click(view.getByRole("button", { name: "Select shown" }));
    fireEvent.click(view.getByRole("button", { name: "Archive selected (2)" }));
    await view.findByText("Archived 2 activity entries.");
    await view.findByText("No activity matches these filters.");

    fireEvent.change(view.getByLabelText("Show"), { target: { value: "archived" } });
    await view.findByText(activityError.message);
    assert.equal(reads.at(-1)!.searchParams.get("archived"), "archived");
    assert.equal(view.getAllByText("Archived").filter(element => element.tagName !== "OPTION").length, 2);
    fireEvent.click(view.getAllByRole("button", { name: "Restore" })[0]);
    await view.findByText("Restored 1 activity entry.");
    assert.deepEqual(bodies, [
      { ids: [activityEntry.id], archived: true },
      { ids: [activityEntry.id], archived: false },
      { ids: [activityEntry.id, activityError.id], archived: true },
      { ids: [activityEntry.id], archived: false },
    ]);
  } finally { setCsrf(""); }
});
