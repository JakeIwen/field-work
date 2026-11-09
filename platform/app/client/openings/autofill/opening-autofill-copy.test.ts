import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../../testing/test-render");
const { OpeningActions } = await import("../OpeningWorkflow");
const { setCsrf } = await import("../../workspace/api");
import { autofill, coverLetterDocument, opening, resumeDocument, state } from "../../testing/component-fixtures";
import type { Mutate } from "../../workspace/workspace-actions";

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  setCsrf("");
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(postResponse: Promise<Response>) {
  const eligibleOpening = { ...opening, url: autofill.url };
  const saved = { ...autofill, url: eligibleOpening.url };
  const requests: { url: string; method: string }[] = [];
  const mutations: { path: string; body: unknown; method?: string }[] = [];
  const copied: string[] = [];
  setCsrf("test-csrf");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { copied.push(text); },
  } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url.endsWith("/status")) return Response.json({ running: false, phase: "idle" });
    if (url.endsWith("?latest=1")) return Response.json([saved]);
    if (url.endsWith(`/${saved.id}/copied`) && method === "POST") return postResponse;
    if (url.endsWith(`/${saved.id}`)) return new Response("autofill script bytes");
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  const mutate: Mutate = async (path, body, method) => {
    mutations.push({ path, body, method });
    return new Promise(() => {});
  };
  const view = render(createElement(OpeningActions, {
    opening: eligibleOpening, mutate, go: () => {},
    state: { ...state, openings: [eligibleOpening], applications: [], tasks: [],
      documents: [resumeDocument, coverLetterDocument], preparations: [] },
  }));
  return { view, requests, mutations, copied };
}

test("Opening copy reports clipboard and submission completion before workspace state refreshes", async () => {
  const post = deferred<Response>();
  const { view, requests, mutations, copied } = setup(post.promise);
  const button = await view.findByRole("button", { name: "Autofill Script" });
  fireEvent.click(button);

  const copiedButton = await view.findByRole("button", { name: "Copied" });
  assert.equal((copiedButton as HTMLButtonElement).disabled, true);
  assert.deepEqual(copied, ["autofill script bytes"]);
  assert.ok(requests.some(request => request.url.endsWith("/script/copied") && request.method === "POST"));
  assert.deepEqual(mutations, [], "copy recording must not wait for mutate's workspace reload");

  post.resolve(Response.json({ ok: true }));
  const submittedButton = await view.findByRole("button", { name: "Submitted" });
  assert.equal((submittedButton as HTMLButtonElement).disabled, false);
  assert.deepEqual(mutations, [], "the server-pushed invalidation owns the later refresh");
});

test("Opening copy restores its retry label when submission recording fails", async () => {
  const { view, copied } = setup(Promise.resolve(Response.json({ error: "Recording failed" }, { status: 500 })));
  fireEvent.click(await view.findByRole("button", { name: "Autofill Script" }));

  await waitFor(() => assert.match(view.container.textContent || "",
    /Script copied, but submission could not be recorded\. Click Autofill Script to retry\./));
  assert.ok(view.getByRole("button", { name: "Autofill Script" }));
  assert.deepEqual(copied, ["autofill script bytes"]);
});
