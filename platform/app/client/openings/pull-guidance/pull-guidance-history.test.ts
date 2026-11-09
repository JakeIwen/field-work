import assert from "node:assert/strict";
import test from "node:test";
const { fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { guidanceView } = await import("./guidance-test-fixture");
import type { GreenhouseGuidanceHistoryEntry } from "../../../shared/greenhouse-guidance";

const entry: GreenhouseGuidanceHistoryEntry = {
  id: "history/1", instructions: "Prior focus\nInvestigate actual hours and usable vacation.",
  createdAt: "2026-10-01T02:00:00Z", lastUsedAt: "2026-10-25T02:00:00Z",
};

test("history shows America/Denver dates, expands text, and Use fills a dirty draft without saving", async () => {
  const reads: string[] = [];
  globalThis.fetch = async path => { reads.push(String(path)); return Response.json([entry]); };
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  const trigger = view.getByRole("button", { name: "Pull instruction history" });
  trigger.focus(); fireEvent.click(trigger);
  await waitFor(() => assert.ok(view.getByRole("button", { name: "Use" })));
  assert.ok(view.getByRole("dialog", { name: "Pull instruction history" }));
  assert.match(view.getByText(/First used/).textContent!, /Sep 30, 2026.*Oct 24, 2026/);
  const expand = view.getByRole("button", { name: "Show full text" });
  fireEvent.click(expand);
  assert.equal(expand.getAttribute("aria-expanded"), "true");
  fireEvent.click(view.getByRole("button", { name: "Use" }));
  assert.equal((view.getByLabelText("Instructions for new pulls") as HTMLTextAreaElement).value, entry.instructions);
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(reads, ["/api/greenhouse/guidance/history"]);
});

test("history Delete calls the encoded DELETE route and refreshes, with recoverable errors", async () => {
  let fail = true;
  let deleted = false;
  let reads = 0;
  const calls: { path: string; body: unknown; method?: string }[] = [];
  globalThis.fetch = async () => { reads += 1; return Response.json(deleted ? [] : [entry]); };
  const view = guidanceView(async (path, body, method) => {
    calls.push({ path, body, method });
    if (fail) throw new Error("Delete unavailable");
    deleted = true; return { deleted: true };
  });
  fireEvent.click(view.getByRole("button", { name: "Pull instruction history" }));
  await waitFor(() => assert.ok(view.getByRole("button", { name: "Delete saved instructions" })));
  fireEvent.click(view.getByRole("button", { name: "Delete saved instructions" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Delete unavailable/));
  assert.ok(view.getByRole("button", { name: "Use" }));
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Delete saved instructions" }));
  // The entry leaves the list before the refresh read starts, so wait for the read itself.
  await waitFor(() => assert.equal(reads, 2));
  await waitFor(() => assert.ok(view.getByText("No saved instructions yet.")));
  assert.deepEqual(calls[1], { path: "/api/greenhouse/guidance/history/history%2F1", body: undefined, method: "DELETE" });
  assert.equal((view.getByRole("button", { name: "Pull listings" }) as HTMLButtonElement).disabled, false);
});

test("history load errors can retry and native cancel restores the trigger without changing the draft", async () => {
  let fail = true;
  globalThis.fetch = async () => fail ? Response.json({ error: "Read unavailable" }, { status: 503 }) : Response.json([]);
  const view = guidanceView(async () => {});
  const trigger = view.getByRole("button", { name: "Pull instruction history" });
  trigger.focus(); fireEvent.click(trigger);
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Read unavailable/));
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => assert.ok(view.getByText("No saved instructions yet.")));
  fireEvent(view.getByRole("dialog"), new window.Event("cancel", { cancelable: true }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
  assert.equal((view.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled, true);
});
