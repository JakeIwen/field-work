import { Palette } from "lucide-react";
import { openThemeEditor } from "./open-theme-editor";

export default function ThemeEditorButton() {
  return (
    <button type="button" className="icon-button theme-editor-button" aria-label="Appearance & Theme Editor" title="Appearance & Theme Editor" onClick={openThemeEditor}>
      <Palette size={18} aria-hidden="true" />
    </button>
  );
}
