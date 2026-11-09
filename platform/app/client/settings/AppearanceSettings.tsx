import "./appearance-settings.css";
import { useSyncExternalStore } from "react";
import { Palette } from "lucide-react";
import { draftFromActive } from "theme-kit/core";
import InfoTooltip from "../ui/InfoTooltip";
import { getAppearance, subscribeAppearance } from "../appearance/palette";
import { openThemeEditor } from "../appearance/open-theme-editor";
import { builtinThemes } from "../../shared/palette";
import SettingsSection from "./SettingsSection";

export default function AppearanceSettings() {
  const { themes, active } = useSyncExternalStore(subscribeAppearance, getAppearance);
  // Active knobs no saved theme matches show as that theme "adjusted", as the editor names them.
  const current = draftFromActive({ builtins: builtinThemes, themes, active }).name;
  return <SettingsSection
    id="settings-appearance"
    title="Appearance"
    icon={<Palette size={18} aria-hidden="true" />}
    help={<InfoTooltip label="About appearance">Themes recolor Fieldwork in both Soft and Dark; the header switch picks the mode. The theme editor (also the palette button in the header) saves themes with your Fieldwork settings, so every browser and device shows them. Copy theme and Paste theme move a theme to or from other apps that use the same editor. Status colors and PDF pages keep their colors.</InfoTooltip>}
  >
    <div className="panel-body appearance-settings">
      <p>Theme: <strong>{current}</strong></p>
      <button type="button" className="button secondary" onClick={openThemeEditor}>
        <Palette size={14} aria-hidden="true" /> Open theme editor
      </button>
    </div>
  </SettingsSection>;
}
