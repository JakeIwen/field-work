import assert from "node:assert/strict";
import test from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../../testing/test-render");
const { PullMetrics } = await import("./PullMetrics");
import type { PullMetricsResponse } from "../../../shared/greenhouse-pull-metrics";

function response(params: URLSearchParams): PullMetricsResponse {
  const agent = params.get("section") === "agent";
  const key = params.get("groupBy") === "company" ? "example" : params.get("groupBy") === "pull" ? "pull-1" : agent ? "location" : "searchDate";
  const metric = agent ? "location" : "searchDate";
  return {
    generatedAt: "2026-10-25T20:00:00Z", totals: { postings: 1, discards: 1, occurrences: 2, duplicates: agent ? 0 : 3, remembered: agent ? 1 : 0 },
    metrics: [{ metric }], groups: { items: [{ key, label: key === "example" ? "Example" : key === "pull-1" ? "2026-10-25 · pull-1" : agent ? "US eligibility / location restriction" : "Older than 8 days by search date", count: 1, occurrences: 2, share: 1 }], total: 1, nextOffset: null },
    reviewInstructions: "Shared policy: inspect source-backed remote eligibility.",
    ...(params.has("group") ? { postings: { items: [{ key: "example:1", company: "Example", title: "Software Engineer", url: "https://job-boards.greenhouse.io/example/jobs/1", metrics: [{ metric }], decisions: ["excluded" as const], occurrences: 2, remembered: 1, pullDate: "2026-10-25T20:00:00Z", runId: "pull-1" }], total: 1, nextOffset: null } } : {}),
    ...(params.has("posting") ? { evidence: { items: [{ candidateId: "pull-1:example:1", runId: "pull-1", pullDate: "2026-10-25T20:00:00Z", decision: "excluded" as const, reason: "Only Canadian residents may apply.", metrics: [{ metric }], taskId: "review-1", rememberedAt: "2026-10-24T20:00:00Z", softwareAssessment: "Builds product software.", remoteAssessment: "Remote only in Canada.", fitAssessment: "Experience matches, geography does not.", instructions: "Prefer part-time work with verified hours.", prompt: "Review remote software candidate: Example · Software Engineer.", promptSource: "captured" as const }], total: 1, nextOffset: null } } : {}),
  };
}

test("pull metrics stays collapsed and lazy; grouping, filters, expansion, prompts and conversation links work", async () => {
  const original = globalThis.fetch;
  const calls: URLSearchParams[] = [], navigations: unknown[][] = [];
  globalThis.fetch = async url => {
    assert.ok(String(url).startsWith("/api/greenhouse/metrics?"));
    const params = new URL(String(url), "http://localhost").searchParams; calls.push(params);
    return Response.json(response(params));
  };
  try {
    const view = render(createElement(PullMetrics, { go: (...args) => navigations.push(args) }));
    assert.equal(calls.length, 0);
    assert.equal(view.container.querySelector("details")?.open, false);
    fireEvent.click(view.getByText("Pull metrics"));
    await waitFor(() => assert.ok(view.getByText("Older than 8 days by search date", { selector: "summary span" })));
    assert.equal(calls.length, 1);
    fireEvent.change(view.getByLabelText("Group by"), { target: { value: "company" } });
    await waitFor(() => assert.ok(view.getByText("Example", { selector: "summary span" })));
    fireEvent.change(view.getByLabelText("Sort by"), { target: { value: "name" } });
    await waitFor(() => assert.equal(calls.at(-1)?.get("sort"), "name"));
    fireEvent.change(view.getByLabelText("Metric"), { target: { value: "searchDate" } });
    await waitFor(() => assert.equal(calls.at(-1)?.get("metric"), "searchDate"));
    const beforeTyping = calls.length;
    fireEvent.change(view.getByLabelText("Filter postings"), { target: { value: "Example" } });
    assert.equal(calls.length, beforeTyping);
    fireEvent.click(view.getByRole("button", { name: "Filter" }));
    await waitFor(() => assert.equal(calls.at(-1)?.get("search"), "Example"));
    fireEvent.click(view.getByLabelText("Show already saved"));
    await waitFor(() => assert.equal(calls.at(-1)?.get("includeDuplicates"), "true"));
    fireEvent.click(view.getByRole("button", { name: "Agent review" }));
    await waitFor(() => assert.ok(view.getByText("Shared review instructions (current template)")));
    assert.equal(calls.at(-1)?.get("metric"), "");
    fireEvent.click(view.getByText("Shared review instructions (current template)"));
    assert.ok(view.getByText("Shared policy: inspect source-backed remote eligibility."));
    fireEvent.click(view.getByText("Example", { selector: "summary span" }));
    await waitFor(() => assert.ok(view.getByText("Software Engineer", { selector: ".pull-metric-posting-heading span" })));
    assert.equal(view.getByRole("link", { name: "https://job-boards.greenhouse.io/example/jobs/1" }).getAttribute("target"), "_blank");
    fireEvent.click(view.getByText("Review grounds and instructions"));
    await waitFor(() => assert.ok(view.getByText("Only Canadian residents may apply.")));
    for (const text of ["Builds product software.", "Remote only in Canada.", "Experience matches, geography does not.", "Prefer part-time work with verified hours.", "Review remote software candidate: Example · Software Engineer."]) assert.ok(view.getByText(text));
    assert.ok(view.getByText(/Remembered from an earlier review/));
    const link = view.getByRole("link", { name: "Review conversation" });
    assert.equal(link.getAttribute("href"), "#agents/review-1");
    fireEvent.click(link, { ctrlKey: true }); assert.deepEqual([...navigations], []);
    fireEvent.click(link); assert.deepEqual([...navigations], [["agents", "review-1"]]);
    const before = calls.length;
    view.rerender(createElement(PullMetrics, { go: (...args) => navigations.push(args) }));
    assert.equal(calls.length, before);
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.equal(calls.length, before + 1));
    await waitFor(() => assert.equal(view.queryByText("Only Canadian residents may apply."), null));
  } finally { globalThis.fetch = original; }
});

test("metrics read failures are recoverable with Refresh and preserve grouping", async () => {
  const original = globalThis.fetch; let failed = true;
  globalThis.fetch = async url => failed ? Response.json({ error: "Metrics temporarily unavailable" }, { status: 503 }) : Response.json(response(new URL(String(url), "http://localhost").searchParams));
  try {
    const view = render(createElement(PullMetrics, { go: () => {} }));
    fireEvent.click(view.getByText("Pull metrics"));
    await waitFor(() => assert.equal(view.getByRole("alert").textContent, "Metrics temporarily unavailable"));
    failed = false;
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() => assert.equal(view.queryByRole("alert"), null));
    await waitFor(() => assert.ok(view.getByText("Older than 8 days by search date", { selector: "summary span" })));
    assert.equal((view.getByLabelText("Group by") as HTMLSelectElement).value, "metric");
  } finally { globalThis.fetch = original; }
});
