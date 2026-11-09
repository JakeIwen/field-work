import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, renderToStaticMarkup, fireEvent, mutationRecorder, waitFor } = await import("../testing/test-render");
const { PullActivity } = await import("./PullActivity");
const { default: OpeningIntake } = await import("./OpeningIntake");
import { state } from "../testing/component-fixtures";
import { greenhouseActivityLane as lane, greenhouseActivityLevel as level, type GreenhouseActivity, type GreenhousePullSummary } from "../../shared/greenhouse-pull";

const entries: GreenhouseActivity[] = [
  { at: "2026-10-22T12:00:00Z", lane: lane.search, level: level.info, text: "software engineer, page 1: 12 results, 3 new for review" },
  { at: "2026-10-22T12:00:01Z", lane: lane.review, level: level.info, text: "Reviewing Example · Software Engineer", taskId: "review-fixture" },
  { at: "2026-10-22T12:00:02Z", lane: lane.search, level: level.warn, text: "Page interval 3 s → 4 s after HTTP 429" },
  { at: "2026-10-22T12:00:03Z", lane: lane.review, level: level.error, text: "Review interrupted for Example · Software Engineer", taskId: "review-fixture" },
];

test("split activity pane preserves its empty DOM baseline for legacy runs", () => {
  assert.equal(renderToStaticMarkup(createElement(PullActivity, { go: () => {} })), '<div class="pull-activity"><section class="pull-activity-pane" aria-label="Greenhouse"><h3>Greenhouse</h3><div class="pull-activity-scroll" tabindex="0" role="region" aria-label="Greenhouse activity"><p class="muted">No activity yet</p></div></section><section class="pull-activity-pane" aria-label="Reviews"><h3>Reviews</h3><div class="pull-activity-scroll" tabindex="0" role="region" aria-label="Reviews activity"><p class="muted">No activity yet</p></div></section></div>');
});

test("split activity pane separates newest-first lanes, local seconds, severity and real conversation links", () => {
  const navigations: unknown[][] = [];
  const view = render(createElement(PullActivity, { activity: entries, go: (...args) => { navigations.push(args); } }));
  const search = view.getByRole("region", { name: "Greenhouse activity" });
  const reviews = view.getByRole("region", { name: "Reviews activity" });
  assert.equal(search.querySelectorAll("li").length, 2);
  assert.equal(reviews.querySelectorAll("li").length, 2);
  assert.match(search.querySelector("li")!.textContent!, /^12:00:02Page interval/);
  assert.match(reviews.querySelector("li")!.textContent!, /^12:00:03Review interrupted/);
  assert.ok(search.querySelector("li.warning-text"));
  assert.ok(reviews.querySelector("li.error-text"));
  const link = view.getByRole("link", { name: entries[1].text });
  assert.equal(link.getAttribute("href"), "#agents/review-fixture");
  fireEvent.click(link, { ctrlKey: true });
  assert.deepEqual(navigations, []);
  fireEvent.click(link);
  assert.deepEqual(navigations, [["agents", "review-fixture"]]);
  assert.deepEqual(entries.map(entry => entry.at), ["2026-10-22T12:00:00Z", "2026-10-22T12:00:01Z", "2026-10-22T12:00:02Z", "2026-10-22T12:00:03Z"]);
  view.rerender(createElement(PullActivity, { activity: [...entries, { ...entries[0], at: "2026-10-22T12:00:04Z", text: "Search resumed" }], go: () => {} }));
  assert.match(search.querySelector("li")!.textContent!, /Search resumed$/);
});

test("Opening intake includes activity for running and finished pulls without a polling owner", () => {
  const run: GreenhousePullSummary = {
    id: "pull-fixture", query: "software engineer", page: 1, target: 1, status: "running", phase: "Researching",
    discovered: 3, reviewed: 0, existing: 0, excluded: 0, deferred: 0, added: 0, pending: 3,
    addedOpeningIds: [], createdAt: "2026-10-22T12:00:00Z", updatedAt: "2026-10-22T12:00:03Z", activity: entries,
  };
  const { mutate } = mutationRecorder();
  const view = render(createElement(OpeningIntake, { state: { ...state, greenhousePull: run }, mutate, go: () => {} }));
  assert.ok(view.getByRole("region", { name: "Greenhouse activity" }));
  view.rerender(createElement(OpeningIntake, { state: { ...state, greenhousePull: { ...run, status: "target_reached", added: 1 } }, mutate, go: () => {} }));
  assert.ok(view.container.querySelector('.pull-activity-pane[aria-label="Reviews"]'));
  assert.ok(view.getByText(entries[3].text));
});


test("remembered review offers an authenticated retry with recoverable errors and the original conversation", async () => {
  const original = globalThis.fetch;
  const { setCsrf } = await import("../workspace/api");
  setCsrf("fixture-token");
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return requests.length === 1 ? Response.json({ error: "Try later" }, { status: 409 }) : Response.json({ memoryCleared: true, requeued: true });
  };
  try {
    const entry = { ...entries[1], remembered: true, candidateId: "run:board:1", text: "Skipped Example · Software Engineer: reviewed Oct 22 (Excluded)" };
    const view = render(createElement(PullActivity, { activity: [entry], go: () => {}, runId: "run" }));
    assert.equal(view.getByRole("link", { name: entry.text }).getAttribute("href"), "#agents/review-fixture");
    const button = view.getByRole("button", { name: "Review again" });
    assert.match(button.getAttribute("title") ?? "", /running or finishing/);
    fireEvent.click(button);
    await waitFor(() => assert.equal(view.getByRole("alert").textContent, "Try later"));
    fireEvent.click(view.getByRole("button", { name: "Review again" }));
    await waitFor(() => assert.ok(view.getByRole("button", { name: "Memory cleared" }).hasAttribute("disabled")));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "/api/greenhouse/pulls/run/candidates/run%3Aboard%3A1/rereview");
    assert.equal(requests[1].init?.method, "POST");
    assert.equal(new Headers(requests[1].init?.headers).get("X-CSRF-Token"), "fixture-token");
    assert.equal(requests[1].init?.body, "{}");
  } finally { globalThis.fetch = original; setCsrf(""); }
});
