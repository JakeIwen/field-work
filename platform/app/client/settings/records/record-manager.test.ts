import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor, dom } = await import("../../testing/test-render");
const { default: RecordManager } = await import("../RecordManager");
const { setCsrf } = await import("../../workspace/api");
const { formatDate } = await import("../../ui/dates");
import { applicationRow, taskRow, catalogPage, recordDetail } from "./records-fixtures";

const go = () => {};
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };

test("catalog pages on the server, debounces search, and sends kind and sort", async () => {
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    return Response.json(url.searchParams.has("cursor") ? { ...catalogPage, rows: [taskRow], nextCursor: undefined } : catalogPage);
  };
  const view = render(createElement(RecordManager, { go }));
  await view.findByText(applicationRow.title);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("limit"), "50");
  assert.ok(view.getByRole("option", { name: "Application (1)" }));
  assert.ok(view.getByText("2.0 KB"));
  assert.ok(view.getByText(formatDate(applicationRow.at, true)));
  assert.match(view.container.textContent!, /Created/);
  fireEvent.click(view.getByRole("button", { name: "Show more records" }));
  await view.findByText(taskRow.title);
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), "next / record");
  assert.equal(view.getByText("2 records · 2 shown").textContent, "2 records · 2 shown");
  fireEvent.change(view.getByLabelText("Find saved records"), { target: { value: "Ex" } });
  fireEvent.change(view.getByLabelText("Find saved records"), { target: { value: "Example" } });
  assert.equal(requests.length, 2);
  await waitFor(() => assert.equal(requests.length, 3));
  assert.equal(requests[2].searchParams.get("q"), "Example");
  assert.equal(requests[2].searchParams.has("cursor"), false);
  fireEvent.change(view.getByLabelText("Record type"), { target: { value: "application" } });
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("kind"), "application"));
  fireEvent.change(view.getByLabelText("Sort records"), { target: { value: "oldest" } });
  await waitFor(() => assert.equal(requests.at(-1)!.searchParams.get("sort"), "oldest"));
});

test("the catalog requests the saved page size", async () => {
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    return Response.json(catalogPage);
  };
  const view = render(createElement(RecordManager, { go, pageSize: 25 }));
  await view.findByText(applicationRow.title);
  assert.equal(requests[0].searchParams.get("limit"), "25");
});

test("a late catalog response cannot replace a new filter; failed pages retry the same cursor", async () => {
  let release: (response: Response) => void = () => {};
  let failPage = true;
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    if (!url.searchParams.get("kind")) return new Promise(resolve => { release = resolve; });
    if (url.searchParams.has("cursor")) return failPage ? Response.json({ error: "Page unavailable" }, { status: 503 }) : Response.json({ ...catalogPage, rows: [taskRow], nextCursor: undefined });
    return Response.json(catalogPage);
  };
  const view = render(createElement(RecordManager, { go }));
  fireEvent.change(view.getByLabelText("Record type"), { target: { value: "application" } });
  await view.findByText(applicationRow.title);
  release(Response.json({ rows: [], total: 0, counts: {} }));
  await waitFor(() => assert.ok(view.getByText(applicationRow.title)));
  fireEvent.click(view.getByRole("button", { name: "Show more records" }));
  await view.findByRole("alert");
  assert.ok(view.getByText(applicationRow.title));
  failPage = false;
  fireEvent.click(view.getByRole("button", { name: "Retry records" }));
  await view.findByText(taskRow.title);
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), "next / record");
  assert.equal(view.queryByRole("alert"), null);
});

test("record drill-in is lazy and recoverable, with native related links and collapsed stored JSON", async () => {
  const requests: string[] = [];
  let fail = true;
  const navigations: string[][] = [];
  globalThis.fetch = async input => {
    const url = String(input); requests.push(url);
    if (url.startsWith("/api/records?")) return Response.json(catalogPage);
    return fail ? Response.json({ error: "Detail unavailable" }, { status: 503 }) : Response.json(recordDetail);
  };
  const view = render(createElement(RecordManager, { go: (page, id) => navigations.push([page, id!]) }));
  const expand = await view.findByRole("button", { name: `Details for ${applicationRow.title}` });
  assert.equal(requests.length, 1);
  assert.equal(expand.getAttribute("aria-expanded"), "false");
  fireEvent.click(expand);
  await view.findByRole("alert");
  assert.equal(requests[1], "/api/records/application/app%20%2F%20fixture");
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Retry record details" }));
  await view.findByText("Applied on October 29");
  const related = view.getByRole("link", { name: "Example opening" });
  assert.equal(related.getAttribute("href"), "#openings/opening%20%2F%20fixture");
  fireEvent.click(related, { ctrlKey: true });
  assert.equal(navigations.length, 0);
  fireEvent.click(related);
  assert.deepEqual(navigations, [["openings", "opening / fixture"]]);
  assert.equal(view.getByText("Original preparation").tagName, "SPAN");
  assert.ok(view.getByText("Resume needs attention"));
  assert.equal(view.getByText("Stored JSON").closest("details")!.open, false);
  fireEvent.click(view.getByText("Stored JSON"));
  assert.ok(view.getByText(recordDetail.raw));
  assert.ok(view.getByText("Heavy fields and long values are abbreviated."));
  fireEvent.click(expand);
  assert.equal(view.queryByText("Applied on October 29"), null);
});

test("cascading deletion refreshes every loaded catalog page, counts and expanded rows without resetting filters or scroll", async () => {
  const company = { ...applicationRow, kind: "company", id: "company", title: "Example company" };
  const opening = { ...applicationRow, kind: "opening", id: "opening", title: "Example opening" };
  const survivor = { ...taskRow, id: "survivor", title: "Unrelated saved task" };
  const secondSurvivor = { ...survivor, id: "survivor-2", title: "Second unrelated task" };
  const reads: URL[] = [];
  const scrolls: unknown[] = [];
  const originalScroll = window.scrollTo;
  const originalY = window.scrollY;
  window.scrollTo = (...args: unknown[]) => { scrolls.push(args); };
  Object.defineProperty(window, "scrollY", { configurable: true, value: 600 });
  let deleted = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/records") {
      reads.push(url);
      const more = url.searchParams.has("cursor");
      return Response.json(deleted
        ? { rows: more ? [secondSurvivor] : [survivor], total: 2, counts: { task: 2 }, nextCursor: more ? undefined : "fresh-next" }
        : { rows: more ? [applicationRow, taskRow] : [company, opening], total: 6, counts: { application: 1, task: 3, company: 1, opening: 1 }, nextCursor: more ? "old-third" : "old-next" });
    }
    if (url.pathname.endsWith("/deletion")) return Response.json({ token: "fixture", records: [company, opening, applicationRow, taskRow], updatedRecords: [], files: [], editedFiles: [], sharedFiles: 0 });
    if (init?.method === "DELETE") { deleted = true; return Response.json({ deleted: true }); }
    return Response.json(recordDetail);
  };
  setCsrf("fixture");
  try {
    const view = render(createElement(RecordManager, { go }));
    await view.findByText(company.title);
    fireEvent.change(view.getByLabelText("Find saved records"), { target: { value: "Example" } });
    await waitFor(() => assert.equal(reads.at(-1)!.searchParams.get("q"), "Example"));
    fireEvent.change(view.getByLabelText("Sort records"), { target: { value: "oldest" } });
    await view.findByText(company.title);
    fireEvent.click(view.getByRole("button", { name: "Show more records" }));
    await view.findByText(applicationRow.title);
    fireEvent.click(view.getByRole("button", { name: `Details for ${applicationRow.title}` }));
    await view.findByText("Applied on October 29");
    const before = reads.length;
    fireEvent.click(view.getByRole("button", { name: `Delete ${company.title}` }));
    await view.findByText("Review everything being deleted");
    fireEvent.click(view.getByText("Permanently delete"));
    await view.findByText("2 records · 2 shown");
    assert.deepEqual(reads.slice(before).map(url => url.searchParams.get("cursor")), [null, "fresh-next"]);
    assert.ok(reads.slice(before).every(url => url.searchParams.get("q") === "Example" && url.searchParams.get("sort") === "oldest"));
    for (const row of [company, opening, applicationRow, taskRow]) assert.equal(view.queryByRole("button", { name: `Details for ${row.title}` }), null);
    assert.equal(view.queryByText("Applied on October 29"), null);
    assert.ok(view.getByText(secondSurvivor.title));
    assert.ok(view.getByRole("option", { name: "Application (0)" }));
    assert.ok(view.getByRole("option", { name: "Agent task (2)" }));
    assert.equal((view.getByLabelText("Find saved records") as HTMLInputElement).value, "Example");
    assert.equal((view.getByLabelText("Sort records") as HTMLSelectElement).value, "oldest");
    assert.deepEqual(scrolls.at(-1), [{ left: 0, top: 600, behavior: "instant" }]);
  } finally {
    setCsrf(""); window.scrollTo = originalScroll;
    Object.defineProperty(window, "scrollY", { configurable: true, value: originalY });
  }
});

test("record drill-in states how many related records the bounded preview omits", async () => {
  const related = Array.from({ length: 100 }, (_, i) => ({ kind: "task", id: `task-${i}`, title: `Related task ${i}` }));
  globalThis.fetch = async input => Response.json(String(input).startsWith("/api/records?")
    ? catalogPage : { ...recordDetail, related, relatedTotal: 135 });
  const view = render(createElement(RecordManager, { go }));
  fireEvent.click(await view.findByRole("button", { name: `Details for ${applicationRow.title}` }));
  await view.findByText("Showing 100 of 135 related records");
  assert.equal(view.getAllByRole("link", { name: /^Related task / }).length, 100);
});

test("an empty catalog and an initial failure are distinct and recoverable", async () => {
  let fail = true;
  globalThis.fetch = async () => fail ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({ rows: [], total: 0, counts: {} });
  const view = render(createElement(RecordManager, { go }));
  await view.findByRole("alert");
  assert.equal(view.queryByText("No saved records match these filters."), null);
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Retry records" }));
  await view.findByText("No saved records match these filters.");
  assert.equal(view.queryByRole("alert"), null);
});
