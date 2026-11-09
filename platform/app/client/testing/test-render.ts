// Shared DOM harness for client tests. React and Testing Library load dynamically
// below, after the jsdom globals exist; static imports would evaluate first.
import type { Mutate } from "../workspace/workspace-actions";
import { afterEach, after } from "node:test";
import nodeProcess from "node:process";
import { register } from "node:module";
import { JSDOM } from "jsdom";

export { nodeProcess };
const originalTimeZone = nodeProcess.env.TZ;
nodeProcess.env.TZ = "UTC";

register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, context, next) {
    return url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : next(url, context);
  }
`));

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "localStorage", "addEventListener", "removeEventListener", "customElements", "getComputedStyle"] as const;
const originals = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const key of globals) Object.defineProperty(globalThis, key, {
  configurable: true,
  value: key === "addEventListener" || key === "removeEventListener" ? dom.window[key].bind(dom.window) : dom.window[key],
});

export const { createElement } = await import("react");
export const { renderToStaticMarkup } = await import("react-dom/server");
export const { render, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const originalFetch = globalThis.fetch;
afterEach(() => cleanup());
after(() => {
  if (originalTimeZone === undefined) delete nodeProcess.env.TZ;
  else nodeProcess.env.TZ = originalTimeZone;
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

export function mutationRecorder(result: unknown = { version: 5 }) {
  const calls: { path: string; body: unknown; method?: string }[] = [];
  const mutate: Mutate = async (path, body, method) => {
    calls.push({ path, body, method });
    return result;
  };
  return { calls, mutate };
}
