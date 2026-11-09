import { tunableValue, type TunableSettings } from "../../../shared/tunables";
// Hands a saved autofill script to the Greenhouse tab a posting link opened.
// A page cannot run code in another site's tab, so the receiving side is the
// userscript automation/greenhouse/fieldwork-autofill.user.js. It cannot import
// this module; greenhouse-tab-autofill.test.ts runs it against these values.
export const tabAutofillProtocol = 1;
export const tabAutofillMessages = {
  present: "fieldwork-autofill-present",
  ready: "fieldwork-autofill-ready",
  script: "fieldwork-autofill-script",
  accepted: "fieldwork-autofill-accepted",
} as const;

/** Called during the click that opened `tab`; absent when no current script exists. */
export type AutofillTabLauncher = (tab: Window) => void;

export type TabAutofillOutcome = "accepted" | "closed";

/**
 * The handoff's steps, each with its own deadline: the redirect to the form, the userscript's
 * hello (it sends one as the page starts, so a missing userscript shows within seconds), the
 * hydrated form (a little past the userscript's own 60 s wait), and the script's acceptance.
 */
export function tabAutofillTiming(settings: TunableSettings = {}) {
  return { open: tunableValue(settings, "browser.tabOpenS") * 1000,
    userscript: tunableValue(settings, "browser.userscriptGreetS") * 1000,
    form: tunableValue(settings, "browser.formReadyS") * 1000,
    accept: tunableValue(settings, "browser.scriptAcceptS") * 1000 };
}
export const tabAutofillTimeouts = tabAutofillTiming();
type Step = keyof typeof tabAutofillTimeouts;
const overdue: Record<Step, string> = {
  open: "The application form didn't open in the new tab, so autofill didn't run.",
  userscript: "Autofill didn't run: the Fieldwork Greenhouse autofill userscript isn't running in that tab. Install, enable or update it in Tampermonkey, or use Autofill Script.",
  form: "The Greenhouse tab never showed the application form, so autofill didn't run.",
  accept: "The Greenhouse tab didn't confirm the autofill script, so submission wasn't recorded. Check the form before submitting.",
};

type MessageSource = Pick<Window, "addEventListener" | "removeEventListener">;
type TabAutofillOptions = {
  tab: Window;
  formUrl: string;
  script: Promise<string>;
  label: string;
  host?: MessageSource;
  timeouts?: typeof tabAutofillTimeouts;
};

/** The helper refuses every page but its exact form, so the script is only sent to that page. */
export function sameApplicationForm(expected: string, actual: string) {
  try {
    const a = new URL(expected), b = new URL(actual);
    const path = (url: URL) => url.pathname.replace(/\/$/, "");
    if (a.origin !== b.origin || path(a) !== path(b)) return false;
    return a.pathname !== "/embed/job_app" || ["for", "token"].every(key =>
      b.searchParams.getAll(key).length === 1 && b.searchParams.get(key) === a.searchParams.get(key));
  } catch {
    return false;
  }
}

/** Fieldwork can read the tab only while it shares Fieldwork's origin: the blank page before the redirect, or the route's error. */
function readablePage(tab: Window) {
  try {
    return { href: tab.location.href, loaded: tab.document.readyState === "complete" };
  } catch {
    return undefined;
  }
}

/** Waits for the tab's userscript, sends the script to the form's origin only, and resolves once the tab accepts it or closes. */
export function sendAutofillToTab({
  tab, formUrl, script, label, host = window, timeouts = tabAutofillTimeouts,
}: TabAutofillOptions): Promise<TabAutofillOutcome> {
  const formOrigin = new URL(formUrl).origin;
  return new Promise((resolve, reject) => {
    let step: Step = "open", settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = setInterval(() => {
      if (tab.closed) return finish(() => resolve("closed"));
      if (step !== "open") return;
      const page = readablePage(tab);
      if (!page) reach("userscript");
      else if (page.loaded && page.href !== "about:blank")
        fail("Fieldwork couldn't open the application form, so autofill didn't run. The new tab shows why.");
    }, 250);
    function reach(next: Step) {
      step = next;
      clearTimeout(timer);
      timer = setTimeout(() => fail(overdue[next]), timeouts[next]);
    }
    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      host.removeEventListener("message", onMessage);
      settle();
    }
    function fail(message: string) { finish(() => reject(new Error(message))); }
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (event.source !== tab || event.origin !== formOrigin || data?.protocol !== tabAutofillProtocol) return;
      if (data.type === tabAutofillMessages.accepted) {
        if (step === "accept") finish(() => resolve("accepted"));
        return;
      }
      if (step === "accept" || (data.type !== tabAutofillMessages.present && data.type !== tabAutofillMessages.ready)) return;
      if (typeof data.url !== "string" || !sameApplicationForm(formUrl, data.url))
        return fail(`The new tab opened ${String(data.url)} instead of the application form, so autofill didn't run.`);
      if (data.type === tabAutofillMessages.present) {
        if (step !== "form") reach("form");
        return;
      }
      reach("accept");
      script.then(text => {
        if (!settled) tab.postMessage({ type: tabAutofillMessages.script, protocol: tabAutofillProtocol, script: text, label }, formOrigin);
      });
    }
    reach("open");
    script.catch(error => fail(error instanceof Error ? error.message : String(error)));
    host.addEventListener("message", onMessage);
  });
}
