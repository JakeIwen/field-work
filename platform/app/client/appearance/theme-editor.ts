// Fieldwork's adapter for the shared Appearance & Theme Editor pane (theme-kit).
// open-theme-editor.ts loads this module on first use; the pane is reused afterwards.
import { mountThemeEditor, paletteSwatchColors, type ThemeAdapter, type ThemeEditorElement } from "theme-kit";
import { builtinThemes, fieldworkKnobOverrides, fieldworkKnobs } from "../../shared/palette";
import { themeStore } from "./palette";
import { getTheme, setTheme, subscribeTheme, type Theme as Mode } from "./theme";

const modes: readonly { id: Mode; label: string }[] = [{ id: "soft", label: "Soft" }, { id: "dark", label: "Dark" }];

const adapter: ThemeAdapter = {
  knobs: fieldworkKnobOverrides,
  builtins: builtinThemes,
  store: themeStore,
  // The five tokens a theme row previews: surface, sidebar, selection, primary action, focus.
  swatchColors: paletteSwatchColors(fieldworkKnobs, ["--surface", "--sidebar-bg", "--surface-selected", "--primary", "--focus"]),
  mode: {
    options: modes,
    get: getTheme,
    set: id => { const mode = modes.find(option => option.id === id); if (mode) setTheme(mode.id); },
    subscribe: subscribeTheme,
  },
};

let editor: ThemeEditorElement | undefined;
export function showThemeEditor() {
  editor ??= mountThemeEditor(adapter);
  editor.show();
}
