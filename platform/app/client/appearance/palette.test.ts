import type { SavedActiveTheme, SavedThemes } from "../../shared/palette";

import assert from "node:assert/strict";
import test, { describe, beforeEach, afterEach } from "node:test";
import { readFileSync } from "node:fs";
await import("../testing/test-render");
const { knobKeys, themeProblem } = await import("theme-kit/core");
const {
  builtinThemes, fieldworkKnobs, paletteSaveProblem, readSavedPalette, readSavedThemes, themeSaveProblem,
} = await import("../../shared/palette");
const { getAppearance, syncSavedAppearance, themeStore } = await import("./palette");
const { setCsrf } = await import("../workspace/api");

const cacheKey = "fieldwork.palette";
const slate = builtinThemes.find(theme => theme.id === "slate")!;
const rosewood = { id: "rosewood-slate", name: "Rosewood Slate", knobs: { hueNeutral: 360, hueBrand: 240, hueAccent: 70, chroma: 1.15 } };
const root = document.documentElement;
const inline = () => Object.fromEntries(knobKeys.map(key => [key, root.style.getPropertyValue(fieldworkKnobs[key].property)]));

test("the 2026-10-29 palette setting reads as its palette's knobs with the slider adjustments applied", () => {
  assert.deepEqual(readSavedPalette({ palette: "slate", overrides: { hueNeutral: 360, hueBrand: 240, chroma: 1.15 }, revision: 20 }),
    { id: "slate", knobs: rosewood.knobs, revision: 20 });
  assert.deepEqual(readSavedPalette({ palette: "teal", overrides: { hueFocus: 80, chroma: "1" } }),
    { id: "teal", knobs: { hueNeutral: 190, hueBrand: 200, hueAccent: 80, chroma: 0.95 }, revision: 0 });
  assert.deepEqual(readSavedPalette({ palette: "violet", overrides: {} }).id, "sage");
});

test("active theme reads normalize knobs and fall back to Sage", () => {
  assert.deepEqual(readSavedPalette({ id: "rosewood-slate", knobs: { ...rosewood.knobs, chroma: 9 }, revision: 3 }),
    { id: "rosewood-slate", knobs: { ...rosewood.knobs, chroma: 2 }, revision: 3 });
  for (const value of [undefined, null, [], "slate", { id: "Bad Id", knobs: {} }])
    assert.deepEqual(readSavedPalette(value), { id: "sage", knobs: builtinThemes[0]!.knobs, revision: 0 });
});

test("saved theme reads drop unusable entries and any that reuse a built-in id", () => {
  assert.deepEqual(readSavedThemes({ items: [rosewood, { ...slate, name: "Fake" }, { id: "x" }], revision: 4 }), { items: [rosewood], revision: 4 });
  assert.deepEqual(readSavedThemes(undefined), { items: [], revision: 0 });
});

test("writes are validated against Fieldwork's knobs and theme ids", () => {
  assert.equal(paletteSaveProblem({ id: "slate", knobs: slate.knobs }, []), undefined);
  assert.equal(paletteSaveProblem({ id: "rosewood-slate", knobs: rosewood.knobs }, [rosewood]), undefined);
  assert.equal(paletteSaveProblem({ id: "rosewood-slate", knobs: rosewood.knobs }, []), "No theme with id rosewood-slate");
  assert.equal(paletteSaveProblem({ id: "slate", knobs: { ...slate.knobs, hueFocus: 1 } }, []), "Unknown knob hueFocus");
  assert.equal(themeSaveProblem(rosewood), undefined);
  assert.equal(themeSaveProblem({ ...rosewood, id: "slate" }), "Built-in themes can't be changed");
  assert.match(themeSaveProblem({ ...rosewood, knobs: { ...rosewood.knobs, chroma: 3 } }) ?? "", /chroma/);
});

test("built-in themes are valid, uniquely named and Sage matches the CSS fallback knobs", () => {
  for (const theme of builtinThemes) assert.equal(themeProblem(fieldworkKnobs, theme), undefined, theme.id);
  assert.equal(new Set(builtinThemes.map(theme => theme.name.toLowerCase())).size, builtinThemes.length);
  const css = readFileSync(new URL("../styles-theme.css", import.meta.url), "utf8");
  const rule = css.match(/:root \{\s*(--hue-neutral[^}]*)\}/)?.[1] ?? "";
  const cssKnobs = Object.fromEntries([...rule.matchAll(/(--[\w-]+):\s*([\d.]+);/g)].map(([, property, value]) => [property, Number(value)]));
  assert.deepEqual(cssKnobs, Object.fromEntries(knobKeys.map(key => [fieldworkKnobs[key].property, builtinThemes[0]!.knobs[key]])));
});

describe("server-saved theme store", () => {
  const originalFetch = globalThis.fetch;
  let revision = 100;
  let requests: { url: string; method: string; body: unknown }[];
  let reply: (url: string, body: any) => Response;

  beforeEach(() => {
    requests = [];
    setCsrf("palette-test-token");
    reply = (url, body) => url === "/api/settings/palette"
      ? Response.json({ ...body.palette, revision: ++revision })
      : Response.json({ items: url.startsWith("/api/settings/themes/") ? [] : [body.theme], revision: ++revision });
    globalThis.fetch = async (input, init) => {
      assert.equal(new Headers(init?.headers).get("X-CSRF-Token"), "palette-test-token");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(input), method: String(init?.method), body });
      return reply(String(input), body);
    };
    syncSavedAppearance({ palette: { id: "sage", knobs: builtinThemes[0]!.knobs, revision: ++revision }, themes: { items: [], revision: ++revision } });
  });
  afterEach(() => {
    themeStore.preview(null);
    globalThis.fetch = originalFetch;
    setCsrf("");
  });

  test("a snapshot applies the active knobs inline and caches them without writing back", () => {
    syncSavedAppearance({ palette: { id: "slate", knobs: slate.knobs, revision: ++revision } as SavedActiveTheme });
    assert.deepEqual(getAppearance().active, { id: "slate", knobs: slate.knobs });
    assert.deepEqual(inline(), { hueNeutral: "250", hueBrand: "240", hueAccent: "70", chroma: "0.9" });
    assert.deepEqual(JSON.parse(localStorage.getItem(cacheKey) ?? "null"), { id: "slate", knobs: slate.knobs });
    assert.deepEqual(requests, []);
  });

  test("an older snapshot never replaces a newer saved value", async () => {
    const stale = revision;
    await themeStore.activate({ id: "slate", knobs: slate.knobs });
    syncSavedAppearance({ palette: { id: "sage", knobs: builtinThemes[0]!.knobs, revision: stale } as SavedActiveTheme });
    assert.equal(getAppearance().active.id, "slate");
  });

  test("editor actions post to the settings routes and apply the server's reply", async () => {
    const notified: string[] = [];
    const stop = themeStore.subscribe(() => notified.push(getAppearance().active.id));
    await themeStore.saveTheme(rosewood);
    await themeStore.activate({ id: rosewood.id, knobs: rosewood.knobs });
    assert.deepEqual(getAppearance(), { themes: [rosewood], active: { id: rosewood.id, knobs: rosewood.knobs } });
    assert.equal(inline().hueNeutral, "360");
    await themeStore.deleteTheme(rosewood.id);
    stop();
    assert.deepEqual(requests.map(({ url, method, body }) => [method, url, body]), [
      ["POST", "/api/settings/themes", { theme: rosewood }],
      ["POST", "/api/settings/palette", { palette: { id: rosewood.id, knobs: rosewood.knobs } }],
      ["DELETE", "/api/settings/themes/rosewood-slate", undefined],
    ]);
    assert.deepEqual(getAppearance().themes, []);
    assert.deepEqual(notified, ["sage", "rosewood-slate", "rosewood-slate"]);
  });

  test("a preview recolors the page without saving, and null restores the active theme", () => {
    themeStore.preview({ ...builtinThemes[0]!.knobs, hueBrand: 20 });
    assert.equal(inline().hueBrand, "20");
    assert.equal(getAppearance().active.knobs.hueBrand, 160);
    themeStore.preview(null);
    assert.equal(inline().hueBrand, "160");
    assert.deepEqual(requests, []);
  });

  test("a rejected save rejects for the editor and leaves the store unchanged", async () => {
    reply = () => Response.json({ error: "Settings unavailable" }, { status: 500 });
    await assert.rejects(themeStore.activate({ id: "slate", knobs: slate.knobs }), /Settings unavailable/);
    assert.equal(getAppearance().active.id, "sage");
  });

  test("the pre-paint boot script applies the same cached root state as the store", () => {
    const boot = readFileSync(new URL("../../../public/appearance-boot.js", import.meta.url), "utf8");
    const media = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
    localStorage.removeItem("fieldwork.theme");
    try {
      syncSavedAppearance({ palette: { id: rosewood.id, knobs: rosewood.knobs, revision: ++revision } as SavedActiveTheme, themes: { items: [rosewood], revision: ++revision } as SavedThemes });
      const applied = inline();
      root.removeAttribute("style");
      new Function(boot)();
      assert.deepEqual(inline(), applied);
      assert.equal(root.dataset.theme, "dark", "no saved mode follows the system preference");
      assert.equal(root.style.colorScheme, "dark");
      localStorage.setItem("fieldwork.theme", "soft");
      new Function(boot)();
      assert.equal(root.dataset.theme, "soft");
      assert.equal(root.style.colorScheme, "light");
      for (const cache of ["not JSON", JSON.stringify({ palette: "slate", overrides: {} })]) {
        localStorage.setItem(cacheKey, cache);
        root.removeAttribute("style");
        new Function(boot)();
        assert.equal(root.style.getPropertyValue("--hue-brand"), "", "an unreadable or older cache leaves the store to apply the theme");
      }
      assert.deepEqual(requests, []);
    } finally {
      localStorage.removeItem("fieldwork.theme");
      root.removeAttribute("data-theme");
      root.style.removeProperty("color-scheme");
      if (media) Object.defineProperty(window, "matchMedia", media);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  });
});
