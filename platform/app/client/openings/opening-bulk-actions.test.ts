// Bulk Generate Docs coverage lives separately from the broad DOM snapshot baseline.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../testing/test-render");
const { OpeningBulkActions, invertedSelection } = await import("./OpeningBulkActions");
const { setCsrf } = await import("../workspace/api");
import { opening, state } from "../testing/component-fixtures";
import type { ApplicationPreparation } from "../../shared/application-preparation";
import type { TaskSummary } from "../../shared/task-records";
import type { Opening, AppState } from "../../shared/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setCsrf("");
});

function testOpening(id: string, values: Partial<Opening> = {}): Opening {
  return {
    ...opening,
    id,
    company: `Company ${id}`,
    title: `Role ${id}`,
    ...values,
  };
}

function preparation(
  openingId: string,
  status: ApplicationPreparation["status"],
  stale = false,
): ApplicationPreparation {
  return {
    id: `preparation-${openingId}`,
    openingId,
    applicationId: `application-${openingId}`,
    status,
    phase: status === "ready" ? "ready" : "documents",
    message: `Preparation ${status}`,
    createdAt: "2026-10-19T12:00:00Z",
    updatedAt: "2026-10-19T12:00:00Z",
    openingHash: `${openingId}-hash`,
    documentIds: [],
    taskIds: [],
    supportedForm: false,
    stale,
  };
}

function renderBulkActions(
  appState: AppState,
  selection: string[],
  refresh: () => Promise<void>,
  announce: (message: string) => void,
  options: Partial<Parameters<typeof OpeningBulkActions>[0]> = {},
) {
  return render(createElement(OpeningBulkActions, {
    state: appState,
    selection,
    setSelection: () => undefined,
    showDismissed: false,
    refresh,
    announce,
    hiddenSelected: 0,
    visibleIds: appState.openings.map(item => item.id),
    ...options,
  }));
}

test("bulk Generate Docs skips completed work and refreshes once after all starts settle", async () => {
  const openings = [
    testOpening("preparation-busy"),
    testOpening("document-task-busy"),
    testOpening("ready"),
    testOpening("failed"),
    testOpening("paused"),
    testOpening("stale"),
    testOpening("never-generated"),
  ];
  const preparations = [
    preparation("preparation-busy", "running"),
    preparation("ready", "ready"),
    preparation("failed", "failed"),
    preparation("paused", "paused"),
    preparation("stale", "ready", true),
  ];
  const busyDocumentTask: TaskSummary = {
    id: "busy-document-task",
    preset: "posting-application",
    status: "running",
    version: 1,
    prompt: "Generate application documents",
    context: { documentIds: [], openingId: "document-task-busy" },
    messages: [],
    eventCount: 0,
  };
  const appState: AppState = {
    ...state,
    openings,
    preparations,
    tasks: [busyDocumentTask],
  };
  const requestOrder: string[] = [];
  const fetchCalls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requestOrder.push(`api:${path}`);
    fetchCalls.push({ path, init });
    if (path.includes("/paused/")) {
      return Response.json({ error: "fixture failure" }, { status: 500 });
    }
    return Response.json({ ok: true });
  };
  setCsrf("fixture-token");
  const announcements: string[] = [];
  const view = renderBulkActions(
    appState,
    openings.map(item => item.id),
    async () => { requestOrder.push("refresh"); },
    message => announcements.push(message),
  );

  const generate = view.getByRole("button", { name: "Generate Docs" });
  const save = view.getByRole("button", { name: "Save" });
  assert.equal(generate.className, "button secondary small-button");
  assert.equal(generate.nextElementSibling, save);
  assert.match(generate.getAttribute("title") ?? "", /up to 8 preparations/);
  assert.match(generate.getAttribute("title") ?? "", /Shift-click/);
  fireEvent.click(generate);

  await waitFor(() => assert.equal(announcements.length, 1));
  assert.deepEqual(requestOrder, [
    "api:/api/openings/failed/prepare",
    "api:/api/openings/paused/prepare",
    "api:/api/openings/stale/prepare",
    "api:/api/openings/never-generated/prepare",
    "refresh",
  ]);
  assert.deepEqual(
    fetchCalls.map(call => ({
      path: call.path,
      method: call.init?.method,
      body: call.init?.body,
    })),
    ["failed", "paused", "stale", "never-generated"].map(id => ({
      path: `/api/openings/${id}/prepare`,
      method: "POST",
      body: "{}",
    })),
  );
  assert.equal(
    announcements[0],
    "Generate Docs requests accepted: 3 · 2 in progress · 1 already ready · 1 failed",
  );
});

test("bulk Generate Docs announces when no selected opening needs generation", async () => {
  const openings = [
    testOpening("busy"),
    testOpening("ready"),
  ];
  const appState: AppState = {
    ...state,
    openings,
    preparations: [
      preparation("busy", "queued"),
      preparation("ready", "ready"),
    ],
    tasks: [],
  };
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ ok: true });
  };
  setCsrf("fixture-token");
  const announcements: string[] = [];
  const view = renderBulkActions(
    appState,
    openings.map(item => item.id),
    async () => { requests++; },
    message => announcements.push(message),
  );

  fireEvent.click(view.getByRole("button", { name: "Generate Docs" }));

  await waitFor(() => assert.equal(announcements.length, 1));
  assert.equal(requests, 0);
  assert.equal(announcements[0], "No selected openings need Generate Docs · 1 in progress · 1 already ready");
});

for (const scope of ["answers", "full"] as const) {
  test(`bulk ${scope} separates each skip category and finishes answers on a plain click`, async () => {
    const openings = ["busy", "ready", "answers", "stale", "unsupported", "fresh"].map(id => testOpening(id, {
      url: id === "unsupported" ? "https://example.com/job" : "https://job-boards.greenhouse.io/example/jobs/123",
    }));
    const answerRun = (id: string, stale = false): ApplicationPreparation => ({
      ...preparation(id, "ready", stale), scope: "answers", applicationId: undefined,
    });
    const appState: AppState = { ...state, openings, tasks: [], settings: { ...state.settings, parallelPreparations: 5 }, preparations: [
      preparation("busy", "running"), preparation("ready", "ready"), answerRun("answers"), answerRun("stale", true),
    ] };
    const requests: { path: string; body: unknown }[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    };
    setCsrf("fixture-token");
    const announcements: string[] = [];
    const view = renderBulkActions(appState, openings.map(o => o.id), async () => {}, message => announcements.push(message));
    const button = view.getByRole("button", { name: "Generate Docs" });
    assert.match(button.getAttribute("title") ?? "", /up to 5 preparations/);
    assert.equal(fireEvent.mouseDown(button, { shiftKey: false }), true);
    assert.equal(fireEvent.mouseDown(button, { shiftKey: true }), false, "Shift must not extend the browser's text selection");
    fireEvent.click(button, { shiftKey: scope === "answers" });
    await waitFor(() => assert.equal(announcements.length, 1));
    const targets = scope === "answers" ? ["stale", "fresh"] : ["answers", "stale", "unsupported", "fresh"];
    assert.deepEqual(requests, targets.map(id => ({ path: `/api/openings/${id}/prepare`, body: scope === "answers" ? { scope } : {} })));
    assert.equal(announcements[0], scope === "answers"
      ? "Answers-only requests accepted: 2 · 1 in progress · 1 already ready · 1 answers already drafted · 1 not autofill-eligible"
      : "Generate Docs requests accepted: 4 · 1 in progress · 1 already ready");
  });
}

test("bulk dismiss keeps four requests busy, refreshes last, and retains failed selections", async () => {
  const openings = Array.from({ length: 7 }, (_, i) => testOpening(`opening-${i}`));
  const selection = openings.map(item => item.id);
  const pending = new Map<string, (response: Response) => void>();
  const requests: string[] = [];
  let active = 0, peak = 0, refreshes = 0;
  let remaining = selection;
  globalThis.fetch = (input, init) => {
    const id = String(input).split("/").at(-1)!;
    requests.push(id);
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedVersion: 0, dismissed: true });
    peak = Math.max(peak, ++active);
    return new Promise<Response>(resolve => pending.set(id, response => { active--; resolve(response); }));
  };
  setCsrf("fixture-token");
  const announcements: string[] = [];
  const view = renderBulkActions({ ...state, personal: {}, openings }, selection, async () => {
    assert.equal(active, 0);
    assert.equal(requests.length, openings.length);
    refreshes++;
  }, message => announcements.push(message), {
    setSelection: update => { remaining = typeof update === "function" ? update(remaining) : update; },
  });
  const button = view.getByRole("button", { name: "Not interested" });
  fireEvent.click(button);
  await waitFor(() => assert.equal(requests.length, 4));
  assert.equal(button.hasAttribute("disabled"), true);
  assert.ok(view.getByText("· 0 of 7 processed"));

  for (const [id, total] of [[2, 5], [4, 6], [5, 7]]) {
    pending.get(`opening-${id}`)!(Response.json({ ok: true }));
    await waitFor(() => assert.equal(requests.length, total));
    assert.equal(active, 4);
    assert.equal(refreshes, 0);
  }
  for (const id of [6, 0, 3]) pending.get(`opening-${id}`)!(Response.json({ ok: true }));
  pending.get("opening-1")!(Response.json({ error: "fixture failure" }, { status: 500 }));
  await waitFor(() => assert.equal(announcements.length, 1));
  assert.equal(peak, 4);
  assert.equal(refreshes, 1);
  assert.deepEqual(remaining, ["opening-1"]);
  assert.equal(announcements[0], "Marked 6 not interested · 1 failed");
  assert.equal(button.hasAttribute("disabled"), false);

  view.rerender(createElement(OpeningBulkActions, {
    state: { ...state, personal: {}, openings }, selection: remaining, showDismissed: false,
    setSelection: update => { remaining = typeof update === "function" ? update(remaining) : update; },
    refresh: async () => { refreshes++; }, announce: message => announcements.push(message),
    hiddenSelected: 0, visibleIds: selection,
  }));
  fireEvent.click(button);
  await waitFor(() => assert.equal(requests.length, 8));
  assert.equal(requests[7], "opening-1");
  pending.get("opening-1")!(Response.json({ ok: true }));
  await waitFor(() => assert.equal(announcements.length, 2));
  assert.deepEqual(remaining, []);
  assert.equal(refreshes, 2);
  assert.equal(announcements[1], "Marked 1 not interested");
});

for (const action of [
  { label: "Mark reviewed", previous: { reviewedHash: opening.hash }, fields: { reviewedHash: opening.hash }, message: "Marked 1 reviewed" },
  { label: "Save", previous: { saved: true }, fields: { saved: true }, message: "Saved 1" },
]) {
  test(`bulk ${action.label} skips unchanged records and preserves the captured version`, async () => {
    const openings = [testOpening("unchanged"), testOpening("change/me")];
    const calls: { path: string; body: unknown }[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    };
    setCsrf("fixture-token");
    let refreshes = 0;
    const announcements: string[] = [];
    const view = renderBulkActions({ ...state, openings, personal: {
      unchanged: { version: 1, ...action.previous },
      "change/me": { version: 4 },
    } }, openings.map(item => item.id), async () => { refreshes++; }, message => announcements.push(message));
    fireEvent.click(view.getByRole("button", { name: action.label }));
    await waitFor(() => assert.equal(announcements.length, 1));
    assert.deepEqual(calls, [{ path: "/api/personal/change%2Fme", body: { expectedVersion: 4, ...action.fields } }]);
    assert.equal(refreshes, 1);
    assert.equal(announcements[0], action.message);
  });
}

test("bulk updates report a refresh failure separately from successful writes", async () => {
  globalThis.fetch = async () => Response.json({ ok: true });
  setCsrf("fixture-token");
  const announcements: string[] = [];
  const view = renderBulkActions({ ...state, personal: {}, openings: [testOpening("saved")] }, ["saved"],
    async () => { throw new Error("offline"); }, message => announcements.push(message));
  const button = view.getByRole("button", { name: "Save" });
  fireEvent.click(button);
  await waitFor(() => assert.equal(announcements.length, 1));
  assert.equal(announcements[0], "Saved 1 · Could not refresh the list; reload to see saved changes");
  assert.equal(button.hasAttribute("disabled"), false);
});

test("Invert selection keeps only the shown rows that were not selected", () => {
  assert.deepEqual(invertedSelection(["a", "hidden"], ["a", "b", "c"]), ["b", "c"]);
  assert.deepEqual(invertedSelection([], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(invertedSelection(["a", "b"], ["a", "b"]), []);
});
