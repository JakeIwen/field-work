import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationPreparation, PreparationStatus } from "../../shared/application-preparation";
import type { AppState } from "../../shared/types";
import { opening, state } from "../testing/component-fixtures";
import { preparationNotice } from "./preparation-notices";

function run(status: PreparationStatus, id = "run", values: Partial<ApplicationPreparation> = {}): ApplicationPreparation {
  return {
    id, openingId: opening.id, status,
    phase: status === "ready" ? "ready" : "documents", message: "",
    createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z",
    openingHash: opening.hash, documentIds: [], taskIds: [], supportedForm: false,
    ...values,
    ...(values.scope === "answers" ? { scope: values.scope, applicationId: undefined } : { scope: undefined, applicationId: values.applicationId ?? "application" }),
  };
}
const snapshot = (preparations: ApplicationPreparation[], limit?: number): AppState => ({
  ...state, preparations, settings: { ...state.settings, parallelPreparations: limit },
});

test("first snapshot is a silent baseline even with running, completed or stopped generations", () => {
  assert.equal(preparationNotice(null, snapshot([run("running"), run("ready", "done"), run("failed", "failed")])), null);
});

test("every status edge reports only the specified starts, finishes and busy stops", () => {
  const statuses: PreparationStatus[] = ["queued", "running", "waiting", "ready", "failed", "paused"];
  for (const before of [undefined, ...statuses]) {
    for (const after of statuses) {
      const previous = before ? [run(before)] : [];
      let event: string | undefined;
      if (before !== after) {
        if (after === "ready") event = "finished";
        else if (["failed", "paused"].includes(after) && before && ["queued", "running", "waiting"].includes(before)) event = "stopped";
        else if (["running", "waiting"].includes(after) && (!before || ["queued", "failed", "paused"].includes(before))) event = "started";
      }
      const notice = preparationNotice(previous, snapshot([run(after)]));
      assert.equal(notice?.text ?? null, event ? `Generate Docs ${event}: ` : null, `${before} → ${after}`);
    }
  }
});

test("single transitions link the Opening and count the next snapshot's running, waiting and queued runs", () => {
  const next = snapshot([run("running"), run("waiting", "waiting"), run("running", "other"), run("queued", "q1"), run("queued", "q2"), run("failed", "old")], 8);
  const previous = next.preparations!.filter(item => item.id !== "run");
  assert.deepEqual(preparationNotice(previous, next), {
    text: "Generate Docs started: ",
    links: [{ label: `${opening.company} — ${opening.title}`, page: "openings", id: opening.id, detail: undefined }],
    suffix: " · 3 of 8 running, 2 queued", more: undefined, tone: "success",
  });
});

test("fast absent-to-ready runs finish only, use the live limit and omit an empty queue", () => {
  const notice = preparationNotice([], snapshot([run("ready")], 12));
  assert.equal(notice?.text, "Generate Docs finished: ");
  assert.equal(notice?.suffix, " · 0 of 12 running");
  assert.equal(notice?.tone, "success");
  assert.equal(preparationNotice([], snapshot([run("running")]))?.suffix, " · 1 of 8 running");
});

test("a finished run and its queued successor coalesce with counts after both changes", () => {
  const notice = preparationNotice([run("running", "first"), run("queued", "second")], snapshot([
    run("running", "second"), run("ready", "first"),
  ], 1));
  assert.equal(notice?.text, "Generate Docs: 1 started, 1 finished · 1 of 1 running");
  assert.deepEqual(notice?.links?.map(link => link.detail), ["started", "finished"]);
});

test("one catch-up snapshot lists at most three transitions and reports the rest", () => {
  const notice = preparationNotice([run("running", "stopped")], snapshot([
    run("running", "a"), run("waiting", "b"), run("ready", "done"), run("paused", "stopped", { message: "App reloaded." }), run("queued", "q"),
  ], 4));
  assert.equal(notice?.text, "Generate Docs: 2 started, 1 finished, 1 stopped · 2 of 4 running, 1 queued");
  assert.equal(notice?.links?.length, 3);
  assert.deepEqual(notice?.links?.map(link => link.detail), ["started", "started", "finished"]);
  assert.equal(notice?.more, 1);
  assert.equal(notice?.tone, "attention", "a stopped transition beyond the visible links still needs the attention icon");
});

test("stops show a short error or message without flooding the toast with long errors", () => {
  const notice = (values: Partial<ApplicationPreparation>) => preparationNotice([run("running")], snapshot([run("failed", "run", values)]));
  assert.equal(notice({ error: "  Profile changed.\n Retry when ready. ", message: "Stopped" })?.links?.[0].detail, "Profile changed. Retry when ready.");
  assert.equal(notice({ error: "Long error ".repeat(30), message: "App reloaded." })?.links?.[0].detail, "App reloaded.");
  assert.equal(notice({ error: "Long error ".repeat(30), message: "Long message ".repeat(30) })?.links?.[0].detail, undefined);
  assert.equal(notice({ error: "Failed" })?.tone, "attention");
});

test("missing Openings use the run id but retain the correct Opening navigation target", () => {
  const notice = preparationNotice([], { ...snapshot([run("ready", "fallback", { openingId: "opening/with spaces" })]), openings: [] });
  assert.deepEqual(notice?.links, [{ label: "fallback", page: "openings", id: "opening/with spaces", detail: undefined }]);
});

test("unchanged snapshots, queue admissions, removals and non-status updates stay silent", () => {
  const previous = [run("running"), run("ready", "ready")];
  assert.equal(preparationNotice(previous, snapshot(previous)), null);
  assert.equal(preparationNotice(previous, snapshot([run("running", "run", { message: "Writing answers" }), run("ready", "ready", { stale: true }), run("queued", "new")])), null);
  assert.equal(preparationNotice(previous, snapshot([])), null);
});

for (const [before, after, event] of [
  ["queued", "running", "started"], ["running", "ready", "finished"], ["running", "failed", "stopped"], ["queued", "paused", "stopped"],
] as const) {
  test(`answers-only ${event} notices name the scope and count both scopes in the shared queue`, () => {
    const answers = (status: PreparationStatus) => run(status, "answers", { scope: "answers", message: after === "failed" ? "Answer task failed." : "" });
    const fullRunning = run("running", "full-running"), fullQueued = run("queued", "full-queued");
    const notice = preparationNotice([answers(before), fullRunning, fullQueued], snapshot([answers(after), fullRunning, fullQueued], 4));
    assert.equal(notice?.text, `Answers-only ${event}: `);
    assert.equal(notice?.suffix, ` · ${after === "running" ? 2 : 1} of 4 running, 1 queued`);
    assert.equal(notice?.links?.[0].id, opening.id);
    assert.equal(notice?.tone, event === "stopped" ? "attention" : "success");
    if (after === "failed") assert.equal(notice?.links?.[0].detail, "Answer task failed.");
  });
}

test("coalesced answers-only transitions keep their own label and existing event details", () => {
  const answers = (status: PreparationStatus, id: string) => run(status, id, { scope: "answers" });
  const notice = preparationNotice([answers("running", "first"), answers("queued", "second")], snapshot([
    answers("ready", "first"), answers("running", "second"), run("queued", "full-queued"),
  ], 2));
  assert.equal(notice?.text, "Answers-only: 1 started, 1 finished · 1 of 2 running, 1 queued");
  assert.deepEqual(notice?.links?.map(link => link.detail), ["finished", "started"]);
});

test("mixed-scope notices label each summary and link while retaining shared capacity counts", () => {
  const notice = preparationNotice([run("running", "answers", { scope: "answers" }), run("running", "failed")], snapshot([
    run("running", "full"), run("ready", "answers", { scope: "answers" }), run("failed", "failed", { error: "PDF failed." }), run("queued", "queued", { scope: "answers" }),
  ], 3));
  assert.equal(notice?.text, "Generate Docs: 1 started, 1 stopped · Answers-only: 1 finished · 1 of 3 running, 1 queued");
  assert.deepEqual(notice?.links?.map(link => link.detail), ["Generate Docs started", "Answers-only finished", "Generate Docs stopped: PDF failed."]);
  assert.equal(notice?.tone, "attention");
});

test("a full run after answers-only completion starts and finishes as Generate Docs", () => {
  const answers = run("ready", "answers", { scope: "answers" });
  const full = run("running", "full");
  assert.equal(preparationNotice([answers], snapshot([full]))?.text, "Generate Docs started: ");
  assert.equal(preparationNotice([full], snapshot([run("ready", "full")]))?.text, "Generate Docs finished: ");
});

test("the hook baselines once and never repeats transitions on rerenders or StrictMode effects", async () => {
  const { createElement, render } = await import("../testing/test-render");
  const { StrictMode } = await import("react");
  const { usePreparationNotices } = await import("./usePreparationNotices");
  const notices: string[] = [];
  const notify = (text: string) => { notices.push(text); };
  function Harness({ value }: { value: AppState | null }) {
    usePreparationNotices(value, notify);
    return null;
  }
  const element = (value: AppState | null) => createElement(StrictMode, null, createElement(Harness, { value }));
  const view = render(element(null));
  view.rerender(element(snapshot([run("running")])));
  assert.deepEqual(notices, []);
  const finished = snapshot([run("ready")]);
  view.rerender(element(finished));
  view.rerender(element({ ...finished }));
  assert.deepEqual(notices, ["Generate Docs finished: "]);
  view.rerender(element(snapshot([run("ready"), run("waiting", "new")])));
  assert.deepEqual(notices, ["Generate Docs finished: ", "Generate Docs started: "]);
});
