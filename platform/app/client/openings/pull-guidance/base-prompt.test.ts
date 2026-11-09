import assert from "node:assert/strict";
import test from "node:test";
import type { GreenhouseReviewPrompt } from "../../../shared/greenhouse-review-prompt";
const { fireEvent, waitFor, mutationRecorder } = await import("../../testing/test-render");
const { guidanceView } = await import("./guidance-test-fixture");

const preview: GreenhouseReviewPrompt = { sections: [
  { title: "Model instructions", text: "Source-backed decisions.\n\nKeep uncertainty explicit." },
  { title: "First user message", text: "Requested posting URL: [POSTING_URL]" },
  { title: "Review instructions · HARVEST-INSTRUCTIONS.md", text: "Scope: Full time\nSaved instructions" },
  { title: "Fieldwork tools", text: '[\n  {"name": "read_job_search_source"}\n]' },
] };
const copiedText = preview.sections.map(section => `${section.title}\n\n${section.text}`).join("\n\n");

function clipboard(value?: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

test("Base prompt fetches only on open, preserves sections, copies and returns focus on close", async () => {
  const requests: string[] = [];
  let resolve!: (response: Response) => void;
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Promise<Response>(done => { resolve = done; });
  };
  const writes: string[] = [];
  clipboard({ writeText: async text => { writes.push(text); } });
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  assert.deepEqual(requests, []);
  const trigger = view.getByRole("button", { name: "Base prompt" });
  assert.equal(trigger.className, "button secondary");
  fireEvent.click(trigger);
  assert.ok(view.getByRole("dialog", { name: "Base prompt" }));
  assert.ok(view.getByText("Loading base prompt…"));
  assert.equal((view.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled, true);
  resolve(Response.json(preview));
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "Model instructions" })));
  for (const section of preview.sections) {
    const heading = view.getByRole("heading", { name: section.title });
    assert.equal(heading.nextElementSibling?.textContent, section.text);
  }
  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  await waitFor(() => assert.ok(view.getByText("Copied")));
  assert.deepEqual(writes, [copiedText]);
  fireEvent.click(view.getByRole("button", { name: "Close Base prompt" }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(calls, [], "Viewing and copying never save guidance or start a pull");
  assert.deepEqual(requests, ["/api/greenhouse/review-prompt"]);
  fireEvent.click(trigger);
  assert.equal(requests.length, 2, "Reopening fetches current saved settings");
  resolve(Response.json(preview));
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "Model instructions" })));
});

test("Base prompt offers selected manual-copy text when clipboard is absent or denied, and Escape returns focus", async () => {
  globalThis.fetch = async () => Response.json(preview);
  const view = guidanceView(async () => {});
  const trigger = view.getByRole("button", { name: "Base prompt" });
  for (const writer of [undefined, { writeText: async () => { throw Error("Denied"); } }]) {
    clipboard(writer);
    fireEvent.click(trigger);
    await waitFor(() => assert.ok(view.getByRole("heading", { name: "Model instructions" })));
    fireEvent.click(view.getByRole("button", { name: "Copy" }));
    await waitFor(() => assert.ok(view.getByLabelText("Base prompt for manual copy")));
    const manual = view.getByLabelText("Base prompt for manual copy") as HTMLTextAreaElement;
    assert.equal(manual.value, copiedText);
    assert.ok(manual.readOnly);
    assert.equal(document.activeElement, manual);
    assert.equal(manual.selectionStart, 0);
    assert.equal(manual.selectionEnd, copiedText.length);
    fireEvent(view.getByRole("dialog"), new window.Event("cancel", { cancelable: true }));
    assert.equal(view.queryByRole("dialog"), null);
    assert.equal(document.activeElement, trigger);
  }
});

test("Base prompt load failures are recoverable without losing or saving the instruction draft", async () => {
  let fail = true;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return fail ? Response.json({ error: "Prompt unavailable" }, { status: 503 }) : Response.json(preview);
  };
  const { calls, mutate } = mutationRecorder();
  const view = guidanceView(mutate);
  fireEvent.change(view.getByLabelText("Instructions for new pulls"), { target: { value: "Unsaved draft" } });
  fireEvent.click(view.getByRole("button", { name: "Base prompt" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent!, /Prompt unavailable/));
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "Model instructions" })));
  assert.equal(view.queryByRole("alert"), null);
  fireEvent.click(view.getByRole("button", { name: "Close Base prompt" }));
  assert.equal((view.getByLabelText("Instructions for new pulls") as HTMLTextAreaElement).value, "Unsaved draft");
  assert.equal(requests, 2);
  assert.deepEqual(calls, []);
});
