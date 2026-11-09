import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { getTheme, setTheme, subscribeTheme } from "./theme";

export default function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      <button type="button" aria-pressed={theme === "soft"} onClick={() => setTheme("soft")}>
        <Sun size={16} aria-hidden="true" /> Soft
      </button>
      <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
        <Moon size={16} aria-hidden="true" /> Dark
      </button>
    </div>
  );
}
