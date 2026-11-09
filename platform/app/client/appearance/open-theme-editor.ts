/** Loads the editor pane on first use, keeping theme-kit's editor out of the startup bundle. */
export function openThemeEditor() {
  void import("./theme-editor").then(({ showThemeEditor }) => showThemeEditor());
}
