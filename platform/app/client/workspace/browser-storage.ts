
/** Browser storage for per-viewer conveniences; never throws. */
export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preference is optional. */ }
}
