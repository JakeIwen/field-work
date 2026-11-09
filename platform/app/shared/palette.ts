// Appearance vocabulary shared by the settings routes, the client store and the
// theme editor adapter: Fieldwork's knob names, its built-in themes and the
// saved setting shapes. The theme model itself is theme-kit's, shared with
// other apps so themes can be copied between them.
import {
  activeThemeProblem,
  knobSpecs,
  normalizeActiveTheme,
  normalizeKnobs,
  normalizeThemes,
  themeProblem,
  type ActiveTheme,
  type KnobSpecOverrides,
  type Theme,
} from "theme-kit/core";

/** Fieldwork labels the accent hue its focus hue; the property is theme-kit's --hue-accent. Defaults are Sage's values. */
export const fieldworkKnobOverrides = {
  hueNeutral: { default: 125 },
  hueBrand: { default: 160 },
  hueAccent: { label: "Focus hue", default: 75 },
} satisfies KnobSpecOverrides;
export const fieldworkKnobs = knobSpecs(fieldworkKnobOverrides);

const theme = (
  id: string,
  name: string,
  hueNeutral: number,
  hueBrand: number,
  hueAccent: number,
  chroma: number,
): Theme => ({ id, name, knobs: { hueNeutral, hueBrand, hueAccent, chroma } });
/** Locked themes. Sage, the first and the fallback, matches the :root knobs in styles-theme.css. */
export const builtinThemes: readonly Theme[] = [
  theme("sage", "Sage", 125, 160, 75, 1),
  theme("slate", "Slate", 250, 240, 70, 0.9),
  theme("clay", "Clay", 75, 55, 200, 0.9),
  theme("plum", "Plum", 320, 330, 75, 0.85),
  theme("teal", "Teal", 190, 200, 50, 0.95),
];
const [defaultTheme] = builtinThemes as [Theme];
export const defaultActiveTheme = (): ActiveTheme => ({
  id: defaultTheme.id,
  knobs: { ...defaultTheme.knobs },
});
export const isBuiltinTheme = (id: string) =>
  builtinThemes.some((builtin) => builtin.id === id);

/** settings.palette: the active theme. Its own revision orders saves without
 * touching settings.version, which other Settings forms use to detect conflicting edits. */
export type SavedActiveTheme = ActiveTheme & { revision: number };
/** settings.themes: the saved themes, revisioned for the same reason. */
export type SavedThemes = { items: Theme[]; revision: number };
export type PaletteSettings = {
  palette?: SavedActiveTheme;
  themes?: SavedThemes;
};
/** Body of POST /api/settings/palette. */
export type PaletteSaveRequest = { palette: ActiveTheme };
/** Body of POST /api/settings/themes; DELETE /api/settings/themes/:id removes one. */
export type ThemeSaveRequest = { theme: Theme };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const revisionOf = (value: unknown) =>
  isRecord(value) &&
  typeof value.revision === "number" &&
  Number.isFinite(value.revision)
    ? value.revision
    : 0;

/** Reads the stored active theme leniently. The 2026-10-29 shape, a palette
 * name plus slider overrides keyed hueFocus, becomes that palette's knobs with
 * the overrides applied. */
export function readSavedPalette(value: unknown): SavedActiveTheme {
  const revision = revisionOf(value);
  if (isRecord(value) && typeof value.palette === "string") {
    const base =
      builtinThemes.find((builtin) => builtin.id === value.palette) ??
      defaultTheme;
    const { hueFocus, ...overrides } = isRecord(value.overrides)
      ? value.overrides
      : {};
    const knobs = normalizeKnobs(
      fieldworkKnobs,
      { ...base.knobs, ...overrides, hueAccent: hueFocus },
      base.knobs,
    );
    return { id: base.id, knobs, revision };
  }
  return {
    ...normalizeActiveTheme(fieldworkKnobs, value, defaultActiveTheme()),
    revision,
  };
}

/** Reads the stored saved themes leniently; an entry reusing a built-in id is dropped. */
export function readSavedThemes(value: unknown): SavedThemes {
  const items = normalizeThemes(
    fieldworkKnobs,
    isRecord(value) ? value.items : undefined,
  );
  return {
    items: items.filter((saved) => !isBuiltinTheme(saved.id)),
    revision: revisionOf(value),
  };
}

/** Validates an active-theme write: the reason it is invalid, or nothing. */
export function paletteSaveProblem(
  value: unknown,
  saved: readonly Theme[],
): string | undefined {
  const problem = activeThemeProblem(fieldworkKnobs, value);
  if (problem) return problem;
  const { id } = value as ActiveTheme;
  return isBuiltinTheme(id) || saved.some((theme) => theme.id === id)
    ? undefined
    : `No theme with id ${id}`;
}

/** Validates a saved-theme write: the reason it is invalid, or nothing. */
export function themeSaveProblem(value: unknown): string | undefined {
  return (
    themeProblem(fieldworkKnobs, value) ??
    (isBuiltinTheme((value as Theme).id)
      ? "Built-in themes can't be changed"
      : undefined)
  );
}
