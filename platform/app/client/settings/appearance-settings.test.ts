import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
const { createElement, render, fireEvent, waitFor } = await import("../testing/test-render");
// The editor's Soft/Dark control loads appearance/theme.ts, which reads the system preference.
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {} }) });
const { default: AppearanceSettings } = await import("./AppearanceSettings");
const { builtinThemes } = await import("../../shared/palette");
const { syncSavedAppearance } = await import("../appearance/palette");

const slate = builtinThemes.find(theme => theme.id === "slate")!;
let revision = 0;
const show = (palette: unknown, items: unknown[] = []) =>
  syncSavedAppearance({ palette: { ...(palette as object), revision: ++revision }, themes: { items, revision: ++revision } } as never);

afterEach(() => {
  show({ id: "sage", knobs: builtinThemes[0]!.knobs });
  document.querySelector("theme-editor")?.remove();
});

test("Appearance names the active theme, keeps help in its tooltip and opens the theme editor", async () => {
  const rosewood = { id: "rosewood-slate", name: "Rosewood Slate", knobs: { ...slate.knobs, hueNeutral: 360, chroma: 1.15 } };
  show({ id: rosewood.id, knobs: rosewood.knobs }, [rosewood]);
  const view = render(createElement(AppearanceSettings));
  assert.equal(view.getByRole("region", { name: "Appearance" }).id, "settings-appearance");
  assert.equal(view.container.querySelector(".appearance-settings p")?.textContent, "Theme: Rosewood Slate");
  assert.equal(view.getByRole("button", { name: "About appearance" }).tagName, "BUTTON");
  fireEvent.click(view.getByRole("button", { name: "Open theme editor" }));
  const editor = await waitFor(() => {
    const mounted = document.querySelector("theme-editor") as (HTMLElement & { isOpen: boolean; shadowRoot: ShadowRoot }) | null;
    assert.equal(mounted?.isOpen, true);
    return mounted!;
  });
  assert.equal(editor.shadowRoot.querySelector<HTMLInputElement>("#te-name")?.value, "Rosewood Slate");
  assert.equal(editor.shadowRoot.querySelector("label[for=te-knob-hueAccent]")?.textContent, "Focus hue");
});

test("older slider adjustments show as their palette, adjusted", () => {
  show({ palette: "slate", overrides: { hueNeutral: 360 } } as never);
  const view = render(createElement(AppearanceSettings));
  assert.equal(view.container.querySelector(".appearance-settings p")?.textContent, "Theme: Slate adjusted");
});
