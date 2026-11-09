// Apply the saved appearance before React renders. Storage is optional (for
// example in a restricted browser); the switch still works for this session.
import { syncThemeColor } from "./theme-color";
export type Theme = "soft" | "dark";
const storageKey = "fieldwork.theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
const parse = (value: string | null): Theme | null =>
  value === "soft" || value === "dark" ? value : null;
let preference: Theme | null = null;
try { preference = parse(localStorage.getItem(storageKey)); } catch { /* Optional. */ }
let current: Theme = preference ?? (system.matches ? "dark" : "soft");

function apply() {
  document.documentElement.dataset.theme = current;
  document.documentElement.style.colorScheme = current === "dark" ? "dark" : "light";
  syncThemeColor();
  listeners.forEach(listener => listener());
}
apply();

export const getTheme = () => current;
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setTheme(theme: Theme) {
  preference = theme;
  current = theme;
  try { localStorage.setItem(storageKey, theme); } catch { /* Keep session choice. */ }
  apply();
}
system.addEventListener("change", () => {
  if (preference) return;
  current = system.matches ? "dark" : "soft";
  apply();
});
window.addEventListener("storage", event => {
  if (event.key !== storageKey && event.key !== null) return;
  // Another tab's event can arrive after this tab's own newer write, so apply
  // what storage holds now rather than the event's value.
  let stored = event.newValue;
  try { stored = localStorage.getItem(storageKey); } catch { /* Use the event's value. */ }
  preference = parse(stored);
  current = preference ?? (system.matches ? "dark" : "soft");
  apply();
});
