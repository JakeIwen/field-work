// Provider-source UI coverage lives separately from the broad DOM snapshot baseline.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const {
  createElement, renderToStaticMarkup, render, cleanup, fireEvent, waitFor, mutationRecorder,
} = await import("../testing/test-render");
const { default: OpeningIntake } = await import("./OpeningIntake");
const { OpeningActions } = await import("./OpeningWorkflow");
const { GenerateDocumentsButton } = await import("../preparation/ApplicationPreparation");
const { Openings, OpeningDetail } = await import("../pages/Openings");
import { autofill, coverLetterDocument, opening, resumeDocument, state } from "../testing/component-fixtures";
import type { AutofillRecord } from "../../shared/greenhouse-autofill";
import type { GreenhousePullSummary } from "../../shared/greenhouse-pull";

const { calls, mutate } = mutationRecorder();
const go = () => {};
const personal = async () => ({});
afterEach(() => { calls.length = 0; });

test("Active legacy pulls stay Greenhouse-only and resume without changing source policy", async () => {
  const run: GreenhousePullSummary = {
    id: "pull", target: 10, added: 5, discovered: 12, reviewed: 9,
    existing: 0, excluded: 3, deferred: 1, pending: 3,
    status: "paused", phase: "3 reviews paused; 1 needs your input",
    query: "software", page: 2, addedOpeningIds: [],
    createdAt: "2026-10-06T18:00:00Z", updatedAt: "2026-10-06T18:01:00Z",
    reviews: [
      { taskId: "one", title: "First employer · Engineer", status: "running" },
      { taskId: "two", title: "Second employer · Engineer", status: "waiting for input" },
      { taskId: "three", title: "Third employer · Engineer", status: "completed" },
    ],
  };
  const view = render(createElement(OpeningIntake, { state: { ...state, greenhousePull: run }, go, mutate }));
  assert.equal(view.container.querySelector("#listing-pull-source"), null);
  assert.equal(view.container.querySelector('label[for="listing-pull-source"]'), null);
  assert.match(view.container.textContent || "", /Pull · Greenhouse · 5 of 10 added/);
  assert.doesNotMatch(view.container.textContent || "", /Ashby|Lever|Source coverage/);
  for (const review of run.reviews!) assert.ok(view.container.querySelector(`a[href="#agents/${review.taskId}"]`));
  assert.match(view.container.textContent || "", /Ready to save/);
  fireEvent.click(view.getByRole("button", { name: "Resume" }));
  await waitFor(() => assert.deepEqual(calls, [{
    path: "/api/greenhouse/pulls/pull/action", body: { action: "resume" }, method: undefined,
  }]));
  const multiRun: GreenhousePullSummary = { ...run,
    status: "target_reached", legacySources: true,
    phase: "Requested number added. Remaining search results were not exhausted.",
  };
  view.rerender(createElement(OpeningIntake, { state: { ...state, greenhousePull: multiRun }, go, mutate }));
  assert.match(view.container.textContent || "", /Pull · Earlier sources · 5 of 10 added · Target reached/);
  assert.doesNotMatch(view.container.textContent || "", /Current source|Source coverage|selected companies checked/);
  assert.equal(view.queryByRole("button", { name: "Resume" }), null);
  view.rerender(createElement(OpeningIntake, { state: { ...state, greenhousePull: { ...multiRun, status: "paused" } }, go, mutate }));
  assert.equal(view.queryByRole("button", { name: "Resume" }), null);
  assert.ok(view.getByRole("button", { name: "Stop pull" }));
});

test("Listing pulls have no source control, validate targets, and omit providers", async () => {
  const view = render(createElement(OpeningIntake, { state: { ...state, greenhousePull: null }, go, mutate }));
  const target = view.getByLabelText("New openings to pull") as HTMLInputElement;
  assert.equal(view.container.querySelector("#listing-pull-source"), null);
  assert.equal(view.container.querySelector('label[for="listing-pull-source"]'), null);
  fireEvent.click(view.getByRole("button", { name: "Pull listings" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const firstBody = calls[0].body as { target: number; clientRequestId: string } & Record<string, unknown>;
  assert.equal(firstBody.target, 10);
  assert.match(firstBody.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal("providers" in firstBody, false);
  calls.length = 0;
  fireEvent.change(target, { target: { value: "101" } });
  fireEvent.submit(view.getByRole("button", { name: "Pull listings" }).closest("form")!);
  assert.match(view.getByRole("alert").textContent || "", /between 1 and 100/);
  assert.equal(calls.length, 0);
  fireEvent.change(target, { target: { value: "7" } });
  fireEvent.click(view.getByRole("button", { name: "Pull listings" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const secondBody = calls[0].body as { target: number } & Record<string, unknown>;
  assert.equal(secondBody.target, 7);
  assert.equal("providers" in secondBody, false);
});

test("Provider dates stay separate from original publication and Added provenance", () => {
  const ashby = { ...opening,
    pullSource: { provider: "ashby" as const, board: "example", postingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", region: "global" as const,
      apiUrl: "https://api.ashbyhq.com/posting", pullId: "pull-date",
      date: { kind: "last-published" as const, value: "2026-10-12", source: "https://api.ashbyhq.com/posting", fetchedAt: "2026-10-13T12:00:00Z" } },
  };
  const view = render(createElement(OpeningDetail, { opening: ashby, state, go, personal, mutate }));
  const dateField = (label: string) => [...view.container.querySelectorAll(".date-grid .field")]
    .find(field => field.querySelector(".field-label")?.textContent === label);
  assert.match(dateField("Posted")?.textContent || "", /Unknown/);
  assert.match(dateField("Added")?.textContent || "", /Sep 28, 2026 \(first seen\)/);
  assert.equal(dateField("Last published on Ashby")?.querySelector("a")?.getAttribute("href"), "https://api.ashbyhq.com/posting");
  assert.match(dateField("Last published on Ashby")?.textContent || "", /Oct 12, 2026/);
  const lever = { ...ashby, pullSource: { ...ashby.pullSource, provider: "lever" as const,
    apiUrl: "https://api.lever.co/posting", date: { ...ashby.pullSource.date, kind: "created" as const,
      source: "https://api.lever.co/posting", value: "2026-10-11" } } };
  view.rerender(createElement(OpeningDetail, { opening: lever, state, go, personal, mutate }));
  assert.equal(dateField("Created on Lever")?.querySelector("a")?.getAttribute("href"), "https://api.lever.co/posting");
});

test("Autofill support includes strict provider identities without changing modified-link navigation", () => {
  const roles = [
    { ...opening, id: "greenhouse-opening", company: "Greenhouse Company", title: "Greenhouse Engineer", url: "https://job-boards.greenhouse.io/example/jobs/123" },
    { ...opening, id: "ashby-opening", company: "Ashby Company", title: "Ashby Engineer", url: "https://jobs.ashbyhq.com/example/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { ...opening, id: "lever-opening", company: "Lever Company", title: "Lever Engineer", url: "https://jobs.lever.co/example/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { ...opening, id: "unsupported-opening", company: "Unsupported Company", title: "Unsupported Engineer", url: "https://jobs.ashbyhq.com/example/not-a-posting-id" },
  ];
  const navigations: [string, string?][] = [];
  const view = render(createElement(Openings, {
    state: { ...state, openings: roles, applications: [] }, selected: "",
    go: (page: string, id?: string) => navigations.push([page, id]), personal, mutate,
  }));
  fireEvent.change(view.getByLabelText("Autofill support"), { target: { value: "supported" } });
  assert.ok(view.container.querySelector('tr[data-opening-id="greenhouse-opening"]'));
  for (const role of roles.slice(1)) assert.equal(view.container.querySelector(`tr[data-opening-id="${role.id}"]`), null);
  fireEvent.change(view.getByLabelText("Autofill support"), { target: { value: "all" } });
  const link = view.getByRole("link", { name: /Ashby Company/ });
  fireEvent.click(link, { ctrlKey: true });
  assert.deepEqual(navigations, []);
  fireEvent.click(link);
  assert.deepEqual(navigations, [["openings", "ashby-opening"]]);
});

test("Generate Docs keeps provider-specific labels for every supported application host", () => {
  for (const [label, url] of [
    ["Greenhouse", "https://job-boards.greenhouse.io/example/jobs/123"],
    ["Ashby", "https://jobs.ashbyhq.com/example/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["Lever", "https://jobs.lever.co/example/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  ]) {
    const html = renderToStaticMarkup(createElement(GenerateDocumentsButton, { openingId: opening.id, openingUrl: url, mutate }));
    if (label === "Greenhouse") {
      assert.ok(html.includes(`Generate Docs (${label})`));
      assert.ok(html.includes(`For this ${label} posting`));
    } else {
      assert.ok(html.includes("Generate Docs"));
      assert.ok(!html.includes(`Generate Docs (${label})`));
    }
  }
});

test("Retired providers retain document downloads without offering new autofill", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const [provider, label, url] of [
      ["ashby", "Ashby", "https://jobs.ashbyhq.com/example/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["lever", "Lever", "https://jobs.lever.co/example/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ] as const) {
      const saved: AutofillRecord = { ...autofill, provider, url, version: 2,
        answers: [{ label: "Why this role?", value: "A reviewed answer", source: "user" }] };
      globalThis.fetch = async input => String(input).endsWith("/status")
        ? Response.json({ running: false, phase: "idle" }) : Response.json([saved]);
      const view = render(createElement(OpeningActions, {
        opening: { ...opening, url }, mutate, go,
        state: { ...state, tasks: [], documents: [resumeDocument, coverLetterDocument], preparations: [] },
      }));
      assert.equal(view.queryByRole("heading", { name: `Written answers (${label})` }), null);
      assert.equal(view.queryByRole("button", { name: "Autofill Script" }), null);
      assert.ok(view.getByRole("link", { name: /Resume PDF/ }));
      cleanup();
    }
  } finally { globalThis.fetch = previousFetch; }
});


test("Opening links resolve Greenhouse forms before navigation and preserve other posting links", () => {
  for (const url of [
    "https://job-boards.greenhouse.io/example/jobs/12345",
    "https://boards.greenhouse.io/example/jobs/123",
    "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123",
    "https://jobs.ashbyhq.com/example/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "https://jobs.lever.co/example/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "https://careers.example.com/job?gh_jid=123",
  ]) {
    const role = { ...opening, id: "opening/with spaces", url };
    const view = render(createElement(OpeningDetail, { opening: role, state, go, personal, mutate }));
    const link = view.getByRole("link", { name: role.title });
    assert.equal(link.getAttribute("href"), new URL(url).hostname.endsWith(".greenhouse.io")
      ? "/api/openings/opening%2Fwith%20spaces/application" : url);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noreferrer");
    assert.equal(calls.length, 0);
    cleanup();
  }
});
