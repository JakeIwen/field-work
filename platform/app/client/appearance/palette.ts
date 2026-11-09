// Fieldwork's theme store for the shared theme editor: the active theme and the
// saved themes from settings, applied to <html> so every browser and device
// shows the same colors. App feeds each state snapshot to syncSavedAppearance;
// editor actions resolve once the server has saved them, and a reply or
// snapshot never replaces a newer revision. The per-browser cache only lets
// public/appearance-boot.js paint the last known theme before the app loads.
import { applyKnobs, type KnobValues } from "theme-kit/core";
import type { ThemeLibrarySnapshot, ThemeStore } from "theme-kit";
import { api } from "../workspace/api";
import { syncThemeColor } from "./theme-color";
import {
  fieldworkKnobs, readSavedPalette, readSavedThemes,
  type PaletteSaveRequest, type PaletteSettings, type SavedActiveTheme, type SavedThemes, type ThemeSaveRequest,
} from "../../shared/palette";

const cacheKey = "fieldwork.palette";
const root = document.documentElement;
const listeners = new Set<() => void>();

// The cache counts as revision 0, so any server value replaces it.
let active: SavedActiveTheme = { ...readCache(), revision: 0 };
let themes: SavedThemes = { items: [], revision: 0 };
let previewKnobs: KnobValues | null = null;
let snapshot: ThemeLibrarySnapshot = { themes: themes.items, active: { id: active.id, knobs: active.knobs } };

function readCache() {
  try { return readSavedPalette(JSON.parse(localStorage.getItem(cacheKey) ?? "null")); }
  catch { return readSavedPalette(null); }
}

function show() {
  applyKnobs(fieldworkKnobs, previewKnobs ?? active.knobs, root.style);
  syncThemeColor();
}
show();

function publish() {
  snapshot = { themes: themes.items, active: { id: active.id, knobs: active.knobs } };
  try { localStorage.setItem(cacheKey, JSON.stringify(snapshot.active)); }
  catch { /* The cache only speeds up the first paint. */ }
  show();
  listeners.forEach(listener => listener());
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Takes the server's active theme and saved themes unless this page already holds a newer revision. */
function learn(nextActive?: SavedActiveTheme, nextThemes?: SavedThemes) {
  let changed = false;
  if (nextActive && nextActive.revision >= active.revision) {
    changed ||= !same({ ...nextActive, revision: 0 }, { ...active, revision: 0 });
    active = nextActive;
  }
  if (nextThemes && nextThemes.revision >= themes.revision) {
    changed ||= !same(nextThemes.items, themes.items);
    themes = nextThemes;
  }
  if (changed) publish();
}

/** Applies the appearance from a state snapshot's settings. */
export function syncSavedAppearance(settings: PaletteSettings | undefined) {
  learn(readSavedPalette(settings?.palette), readSavedThemes(settings?.themes));
}

export const getAppearance = () => snapshot;
export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const themeStore: ThemeStore = {
  snapshot: getAppearance,
  subscribe: subscribeAppearance,
  async saveTheme(theme) {
    const body: ThemeSaveRequest = { theme };
    learn(undefined, readSavedThemes(await api<SavedThemes>("/api/settings/themes", body)));
  },
  async deleteTheme(id) {
    learn(undefined, readSavedThemes(await api<SavedThemes>(`/api/settings/themes/${encodeURIComponent(id)}`, undefined, "DELETE")));
  },
  async activate(next) {
    const body: PaletteSaveRequest = { palette: next };
    learn(readSavedPalette(await api<SavedActiveTheme>("/api/settings/palette", body)));
  },
  preview(knobs) {
    previewKnobs = knobs;
    show();
  },
};
