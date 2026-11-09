// Apply the saved Soft/Dark mode and the last known theme before the first
// paint, so a slow bundle never flashes the default colors. app/client/appearance/theme.ts
// owns the mode; app/client/appearance/palette.ts caches the active theme here
// ({id, knobs}) and applies the server's once state loads. Keep the keys and knob
// properties in step with them and shared/palette.ts (palette.test.ts runs this script).
(() => {
  const root = document.documentElement;
  const read = key => {
    try { return window.localStorage.getItem(key); } catch { return null; }
  };
  let theme = read("fieldwork.theme");
  if (theme !== "soft" && theme !== "dark") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "soft";
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "dark" ? "dark" : "light";
  let saved = null;
  try { saved = JSON.parse(read("fieldwork.palette") ?? "null"); } catch { /* palette.ts applies the theme. */ }
  const knobs = saved && typeof saved === "object" ? saved.knobs : null;
  if (!knobs || typeof knobs !== "object") return;
  const properties = { hueNeutral: "--hue-neutral", hueBrand: "--hue-brand", hueAccent: "--hue-accent", chroma: "--chroma" };
  for (const [key, property] of Object.entries(properties)) {
    const value = knobs[key];
    if (typeof value === "number" && Number.isFinite(value)) root.style.setProperty(property, String(value));
  }
})();
