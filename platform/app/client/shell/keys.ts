// Shared keyboard-shortcut helpers. Both the app shell (global shortcuts) and
// page-level lists (j/k navigation) use these so shortcuts never fire while
// the user is typing.
export function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.closest("[contenteditable=''], [contenteditable='true'], [role='textbox']");
}
export function hasModifier(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey || e.altKey;
}
