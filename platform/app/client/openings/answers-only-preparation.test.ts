import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ApplicationPreparation } from "../../shared/application-preparation";
import type { AutofillRecord } from "../../shared/greenhouse-autofill";
import { opening, state } from "../testing/component-fixtures";
import { sortOpenings } from "./opening-sort";
const { createElement, render, fireEvent, waitFor, mutationRecorder } = await import("../testing/test-render");
const { Openings } = await import("../pages/Openings");
const { OpeningActions } = await import("./OpeningWorkflow");
const { GenerateDocumentsButton, PreparationStatusLine } = await import("../preparation/ApplicationPreparation");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; localStorage.clear(); });
const url = "https://job-boards.greenhouse.io/example/jobs/123";
const run: ApplicationPreparation = {
  id: "answers", scope: "answers", openingId: opening.id, status: "ready", phase: "ready",
  message: "Answers drafted", createdAt: "2026-10-30", updatedAt: "2026-10-30", openingHash: opening.hash,
  taskIds: [], documentIds: [], supportedForm: true,
};
const record: AutofillRecord = {
  id: "script", openingId: opening.id, version: 1, createdAt: "2026-10-30", url, title: opening.title,
  openingHash: opening.hash, sourceHash: "source", profileHash: "profile", helperHash: "helper", scriptHash: "script", evidenceHash: "evidence",
  answers: [], attachments: [], dynamicQuestions: [], review: [{ label: "Other question", required: true, reason: "Answer this yourself" }],
};

test("autofill sort includes answers counts, breaks ties with complete scripts first, and leaves blanks last", () => {
  const rows = ["blank", "answers-two", "complete-two", "answers-zero", "complete-one"].map(id => ({ ...opening, id, company: id }));
  const counts = { "answers-two": { scope: "answers" as const, count: 2 }, "answers-zero": { scope: "answers" as const, count: 0 } };
  assert.deepEqual(sortOpenings(rows, "autofill-ready", {}, { "complete-two": 2, "complete-one": 1 }, [], counts).map(o => o.id),
    ["answers-zero", "complete-one", "complete-two", "answers-two", "blank"]);
});

test("row Shift-click queues only answers without selecting a range or navigating", async () => {
  const calls = mutationRecorder();
  const navigation: string[] = [];
  globalThis.fetch = async () => Response.json({ running: false });
  const openings = [{ ...opening, id: "one", url }, { ...opening, id: "two", url, company: "Another" }];
  const view = render(createElement(Openings, { state: { ...state, openings, preparations: [], tasks: [], applications: [], personal: {} },
    selected: "", mutate: calls.mutate, personal: async () => {}, go: (page: string) => { navigation.push(page); } }));
  const checks = view.getAllByRole("checkbox", { name: /^Select (?!all)/ });
  fireEvent.click(checks[0]);
  const before = checks.map(input => (input as HTMLInputElement).checked);
  const button = view.getAllByRole("button", { name: /^Generate Docs.*for/ })[1];
  assert.equal(fireEvent.mouseDown(button, { shiftKey: false }), true, "ordinary clicks keep their native focus behavior");
  assert.equal(fireEvent.mouseDown(button, { shiftKey: true }), false, "Shift must not extend a native text selection across rows");
  fireEvent.click(button, { shiftKey: true });
  await waitFor(() => assert.equal(calls.calls.length, 1));
  assert.deepEqual(calls.calls[0].body, { scope: "answers" });
  assert.deepEqual(checks.map(input => (input as HTMLInputElement).checked), before);
  assert.deepEqual(navigation, []);
});

test("answers-only row has an info count, Shift-click is a no-op toast, and a plain click finishes", async () => {
  const calls = mutationRecorder();
  const notices: string[] = [];
  const view = render(createElement(GenerateDocumentsButton, { openingId: opening.id, openingUrl: url, run,
    compact: true, answerCount: { scope: "answers", count: 1 }, mutate: calls.mutate, announce: message => notices.push(message) }));
  const button = view.getByRole("button", { name: /Generate Docs/ });
  assert.equal(button.textContent, "(1)");
  assert.ok(button.classList.contains("materials-answers-only"));
  assert.ok(!button.classList.contains("materials-need-attention"));
  assert.match(button.title, /documents not generated.*1 item to answer yourself.*Click.*Shift-click/);
  fireEvent.click(button, { shiftKey: true });
  assert.equal(calls.calls.length, 0);
  assert.match(notices[0], /already drafted/);
  fireEvent.click(button);
  await waitFor(() => assert.equal(calls.calls.length, 1));
  assert.deepEqual(calls.calls[0].body, {});
});

test("Shift-click skips current full-ready rows and reports unsupported-form errors", async () => {
  const notices: string[] = [];
  const calls = mutationRecorder();
  const ready: ApplicationPreparation = { ...run, scope: undefined, applicationId: "application" };
  const props = { openingId: opening.id, openingUrl: url, compact: true, mutate: calls.mutate, announce: (message: string) => notices.push(message) };
  const view = render(createElement(GenerateDocumentsButton, { ...props, run: ready }));
  fireEvent.click(view.getByRole("button"), { shiftKey: true });
  assert.equal(calls.calls.length, 0);
  assert.match(notices[0], /already ready/);
  view.rerender(createElement(GenerateDocumentsButton, { ...props, openingUrl: "https://example.com/job", mutate: async () => { throw new Error("Answers-only preparation requires a supported Greenhouse application form."); } }));
  fireEvent.click(view.getByRole("button"), { shiftKey: true });
  await waitFor(() => assert.equal(notices.length, 2));
  assert.match(notices[1], /supported Greenhouse/);
});

test("answers-only exploration adds no Application document-status line", () => {
  const view = render(createElement(PreparationStatusLine, { run, openingId: opening.id, go() {} }));
  assert.equal(view.container.innerHTML, "");
});

for (const scope of ["answers", "full"] as const) {
  test(`submitted ${scope} display does not hide staleness from Shift-click decisions`, async () => {
    const calls = mutationRecorder();
    const stale: ApplicationPreparation = scope === "answers" ? { ...run, stale: true } : { ...run, stale: true, scope: undefined, applicationId: "application" };
    const view = render(createElement(GenerateDocumentsButton, { openingId: opening.id, openingUrl: url, run: stale,
      submitted: true, compact: true, mutate: calls.mutate }));
    const button = view.getByRole("button");
    assert.equal(button.classList.contains("materials-need-attention"), scope === "answers");
    fireEvent.click(button, { shiftKey: true });
    await waitFor(() => assert.equal(calls.calls.length, 1));
    assert.deepEqual(calls.calls[0].body, { scope: "answers" });
  });
}

for (const status of ["ready", "failed", "paused", "stale"] as const) {
  test(`Opening detail treats ${status} answers-only preparation appropriately`, async () => {
    globalThis.fetch = async input => Response.json(String(input).endsWith("/status") ? { running: false } : [record]);
    const preparation: ApplicationPreparation = { ...run, status: status === "stale" ? "ready" : status, stale: status === "stale", error: status === "failed" ? "Answer generation failed" : undefined };
    const calls = mutationRecorder();
    const view = render(createElement(OpeningActions, { opening: { ...opening, url }, state: { ...state, applications: [], documents: [], tasks: [], preparations: [preparation] }, mutate: calls.mutate, go() {} }));
    await waitFor(() => assert.ok(view.getByRole("button", { name: "Generate Docs" })));
    assert.equal(view.queryByRole("button", { name: "Autofill Script" }), null);
    assert.equal(!!view.container.querySelector(".material-answers-status"), status === "ready");
    assert.equal(!!view.container.querySelector(".materials-need-attention"), status !== "ready");
    if (status === "ready") {
      assert.match(view.container.querySelector(".material-answers-status")?.textContent ?? "", /1 item to answer yourself/);
      fireEvent.click(view.getByRole("button", { name: "Generate Docs" }));
      await waitFor(() => assert.equal(calls.calls.length, 1));
      assert.deepEqual(calls.calls[0].body, {});
    }
  });
}
