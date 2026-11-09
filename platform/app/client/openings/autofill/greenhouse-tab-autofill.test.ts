// Runs the real userscript in its own Greenhouse-origin window against the
// Fieldwork side of the handshake, so the two halves cannot drift apart.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { sameApplicationForm, sendAutofillToTab, tabAutofillMessages, tabAutofillTimeouts } from "./greenhouse-tab-autofill";

const userscript = readFileSync(new URL("../../../../../automation/greenhouse/fieldwork-autofill.user.js", import.meta.url), "utf8");
const formUrl = "https://job-boards.greenhouse.io/example/jobs/123";
const greenhouseOrigin = "https://job-boards.greenhouse.io";
const fieldworkOrigin = "http://127.0.0.1:4317";
const savedScript = `// Fieldwork autofill. Review the form before submitting.
(async function fillGreenhouse(plan) {
  document.getElementById('first_name').value = plan.firstName;
  return {report: [], attachments: [], missingRequired: ['Resume/CV'], review: [{label: 'Pronouns'}], submitted: false};
})({"firstName": "Alex"});
`;

type Posted = { from: "fieldwork" | "greenhouse"; data: any; targetOrigin: string };

// Closing each page stops the userscript's wait for a form that a test never hydrates.
const pages: InstanceType<typeof JSDOM>[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });

/** Two windows joined by postMessage as a browser would: `tab` is Fieldwork's handle, `opener` the Greenhouse page's. */
function openedTab(pageUrl: string, { hydrated = true } = {}) {
  const greenhouse = new JSDOM(`<!doctype html><body><form id="application-form"><input id="first_name"></form></body>`,
    { url: pageUrl, runScripts: "outside-only" });
  pages.push(greenhouse);
  // React marks the nodes it has hydrated; the userscript waits for that before answering.
  const hydrate = () => Object.assign(greenhouse.window.document.getElementById("application-form")!, { "__reactFiber$test": {} });
  if (hydrated) hydrate();
  const host = new EventTarget();
  const posted: Posted[] = [];
  const tab = {
    closed: false,
    postMessage(data: unknown, targetOrigin: string) {
      posted.push({ from: "fieldwork", data, targetOrigin });
      if (targetOrigin === greenhouseOrigin)
        setTimeout(() => greenhouse.window.dispatchEvent(new greenhouse.window.MessageEvent("message",
          { data: structuredClone(data), origin: fieldworkOrigin, source: opener as any })));
    },
  };
  const opener = {
    postMessage(data: unknown, targetOrigin: string) {
      posted.push({ from: "greenhouse", data, targetOrigin });
      if (targetOrigin === "*" || targetOrigin === fieldworkOrigin)
        setTimeout(() => host.dispatchEvent(Object.assign(new Event("message"),
          { data: structuredClone(data), origin: greenhouseOrigin, source: tab })));
    },
  };
  Object.defineProperty(greenhouse.window, "opener", { configurable: true, writable: true, value: opener });
  const panelText = () => greenhouse.window.document.documentElement.lastElementChild?.shadowRoot?.textContent ?? "";
  return { greenhouse, host, tab, opener, posted, panelText, hydrate, runUserscript: () => greenhouse.window.eval(userscript) };
}

function send(opened: Pick<ReturnType<typeof openedTab>, "tab" | "host">,
  options: { timeouts?: Partial<typeof tabAutofillTimeouts>; script?: Promise<string> } = {}) {
  return sendAutofillToTab({
    tab: opened.tab as unknown as Window, formUrl, script: options.script ?? Promise.resolve(savedScript), label: "v3",
    host: opened.host as unknown as Window, timeouts: { ...tabAutofillTimeouts, ...options.timeouts },
  });
}

const settles = (promise: Promise<unknown>) => {
  const state = { settled: false };
  promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
};

test("the userscript runs the saved script that a Fieldwork click sends to its exact form", async () => {
  const opened = openedTab(formUrl);
  const outcome = send(opened);
  opened.runUserscript();
  assert.equal(await outcome, "accepted");

  const scriptMessage = opened.posted.find(p => p.data.type === tabAutofillMessages.script);
  assert.equal(scriptMessage?.targetOrigin, greenhouseOrigin, "the script only goes to the form's origin");
  assert.equal(scriptMessage?.data.script, savedScript);
  for (let i = 0; i < 100 && !opened.panelText().includes("Finished"); i++) await new Promise(r => setTimeout(r, 20));
  const document = opened.greenhouse.window.document;
  assert.equal((document.getElementById("first_name") as HTMLInputElement).value, "Alex");
  assert.match(opened.panelText(), /Fieldwork autofill v3/);
  assert.match(opened.panelText(), /Finished\. Still required:Resume\/CV/);
  assert.match(opened.panelText(), /1 optional field is left for you\..*Nothing was submitted\./);
  assert.equal(opened.greenhouse.window.opener, null, "the page loses its handle on Fieldwork once the script arrives");
});

test("the userscript answers only after React hydrates the form, so hydration cannot discard its work", async () => {
  const opened = openedTab(formUrl, { hydrated: false });
  const outcome = send(opened);
  opened.runUserscript();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(opened.posted.map(p => p.data.type), [tabAutofillMessages.present],
    "a hello at once, but no ready message while the page is still server markup");
  opened.hydrate();
  assert.equal(await outcome, "accepted");
});

test("Fieldwork sends nothing when the tab lands somewhere other than the form, and says so from the userscript's hello", async () => {
  const opened = openedTab("https://job-boards.greenhouse.io/example?error=true", { hydrated: false });
  const outcome = send(opened);
  opened.runUserscript();
  await assert.rejects(outcome, /opened https:\/\/job-boards\.greenhouse\.io\/example\?error=true instead of the application form/);
  assert.deepEqual(opened.posted.map(p => p.data.type), [tabAutofillMessages.present]);
});

test("the userscript ignores scripts from other origins and from windows other than its opener", async () => {
  const opened = openedTab(formUrl);
  opened.runUserscript();
  const window = opened.greenhouse.window;
  const message = { type: tabAutofillMessages.script, protocol: 1, script: "document.title = 'ran'", label: "" };
  window.dispatchEvent(new window.MessageEvent("message", { data: message, origin: "https://example.com", source: opened.opener as any }));
  window.dispatchEvent(new window.MessageEvent("message", { data: message, origin: fieldworkOrigin, source: {} as any }));
  await new Promise(r => setTimeout(r, 50));
  assert.notEqual(window.document.title, "ran");
  assert.deepEqual(opened.posted.map(p => p.data.type), [tabAutofillMessages.present, tabAutofillMessages.ready]);
});

test("a Greenhouse tab that never greets Fieldwork reports a missing userscript within its own deadline", async () => {
  const outcome = send(openedTab(formUrl), { timeouts: { userscript: 30 } });
  await assert.rejects(outcome, /userscript isn't running in that tab\. Install, enable or update it in Tampermonkey/);
});

test("a userscript that greets but never finds a hydrated form gets the form deadline instead", async () => {
  const opened = openedTab(formUrl, { hydrated: false });
  const outcome = send(opened, { timeouts: { userscript: 30, form: 400 } });
  opened.runUserscript();
  await assert.rejects(outcome, /never showed the application form/);
});

test("while the tab is still Fieldwork's, Fieldwork waits out the redirect and reports its own error page", async () => {
  const page = { href: "about:blank" };
  const tab = { closed: false, postMessage() {}, location: page, document: { readyState: "complete" } };
  const outcome = send({ tab, host: new EventTarget() }, { timeouts: { userscript: 30 } });
  const state = settles(outcome);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(state.settled, false, "the blank page before the redirect is not a failure");
  page.href = `${fieldworkOrigin}/api/openings/example/application`;
  await assert.rejects(outcome, /Fieldwork couldn't open the application form.*The new tab shows why\./);
});

test("a failed script load stops at once, and a closed tab ends quietly", async () => {
  await assert.rejects(send(openedTab(formUrl), { script: Promise.reject(new Error("Could not load the script.")) }), /Could not load the script\./);
  const closing = openedTab(formUrl);
  const outcome = send(closing);
  closing.tab.closed = true;
  assert.equal(await outcome, "closed");
});

test("form matching follows the helper's own page guard", () => {
  assert.ok(sameApplicationForm(formUrl, `${formUrl}/?gh_src=linkedin#app`));
  assert.ok(!sameApplicationForm(formUrl, "https://boards.greenhouse.io/example/jobs/123"));
  const embed = "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123";
  assert.ok(sameApplicationForm(embed, `${embed}&utm_source=x`));
  assert.ok(!sameApplicationForm(embed, "https://job-boards.greenhouse.io/embed/job_app?for=example&token=124"));
  assert.ok(!sameApplicationForm(embed, `${embed}&token=123`));
});
