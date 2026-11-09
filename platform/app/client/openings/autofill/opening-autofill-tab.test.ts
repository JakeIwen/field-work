import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../../testing/test-render");
const { Fragment, createRef } = await import("react");
const { OpeningActions } = await import("../OpeningWorkflow");
const { default: OpeningPostingLink } = await import("../OpeningPostingLink");
const { setCsrf } = await import("../../workspace/api");
import { autofill, coverLetterDocument, opening, resumeDocument, state } from "../../testing/component-fixtures";
import { tabAutofillMessages, type AutofillTabLauncher } from "./greenhouse-tab-autofill";
import type { MutableRefObject } from "react";

const greenhouseOrigin = "https://job-boards.greenhouse.io";
const open = window.open;
afterEach(() => { setCsrf(""); window.open = open; });

function setup() {
  const eligibleOpening = { ...opening, url: autofill.url };
  const requests: { url: string; method: string }[] = [];
  const opened: string[] = [];
  const sent: { data: any; targetOrigin: string }[] = [];
  const tab = { closed: false, postMessage: (data: unknown, targetOrigin: string) => { sent.push({ data, targetOrigin }); } };
  setCsrf("test-csrf");
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url.endsWith("/status")) return Response.json({ running: false, phase: "idle" });
    if (url.endsWith("?latest=1")) return Response.json([autofill]);
    if (url.endsWith(`/${autofill.id}/copied`) && method === "POST") return Response.json({ ok: true });
    if (url.endsWith(`/${autofill.id}`)) return new Response("autofill script bytes");
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  window.open = ((url: string) => { opened.push(url); return tab; }) as typeof window.open;
  const launcher = createRef() as MutableRefObject<AutofillTabLauncher | undefined>;
  const view = render(createElement(Fragment, null,
    createElement(OpeningPostingLink, { opening: eligibleOpening, autofillLauncher: launcher }),
    createElement(OpeningActions, { opening: eligibleOpening, autofillLauncher: launcher, mutate: async () => ({}), go: () => {},
      state: { ...state, openings: [eligibleOpening], applications: [], tasks: [], documents: [resumeDocument, coverLetterDocument], preparations: [] } })));
  const fromTab = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: greenhouseOrigin, source: tab as any }));
  return { view, requests, opened, sent, fromTab, launcher, link: view.getByRole("link", { name: opening.title }) };
}

test("clicking the Greenhouse title opens the form, hands it the script and records submission once the tab accepts", async () => {
  const { view, requests, opened, sent, fromTab, launcher, link } = setup();
  await view.findByRole("button", { name: "Autofill Script" });
  await waitFor(() => assert.equal(typeof launcher.current, "function"));
  assert.equal(fireEvent.click(link), false, "the app opens the tab itself");
  assert.deepEqual(opened, [`/api/openings/${encodeURIComponent(opening.id)}/application`]);
  await view.findByText("Waiting for the Greenhouse tab to load the autofill userscript…");

  fromTab({ type: tabAutofillMessages.ready, protocol: 1, url: autofill.url });
  await waitFor(() => assert.equal(sent.length, 1));
  assert.deepEqual(sent[0], { targetOrigin: greenhouseOrigin,
    data: { type: tabAutofillMessages.script, protocol: 1, script: "autofill script bytes", label: "v1" } });
  assert.ok(!requests.some(r => r.url.endsWith("/copied")), "nothing is recorded before the tab accepts");

  fromTab({ type: tabAutofillMessages.accepted, protocol: 1 });
  await view.findByRole("button", { name: "Submitted" });
  assert.ok(requests.some(r => r.url.endsWith(`/${autofill.id}/copied`) && r.method === "POST"));
});

test("modified clicks keep the browser's link behavior and start nothing", async () => {
  const { view, opened, launcher, link } = setup();
  await view.findByRole("button", { name: "Autofill Script" });
  await waitFor(() => assert.equal(typeof launcher.current, "function"));
  assert.equal(fireEvent.click(link, { metaKey: true }), true);
  assert.equal(fireEvent.click(link, { button: 1 }), true);
  assert.deepEqual(opened, []);
});
