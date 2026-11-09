import { tunables } from "../../shared/tunables";
type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;


/** A queued reload remains discoverable across navigation without polling hidden tabs. */
export function pollReloadStatus(refresh: () => Promise<void>, visibility: VisibilitySource = document, timing: () => { baseDelayMs: number; maximumDelayMs: number } = () => ({ baseDelayMs: tunables["browser.reloadPollMs"].default, maximumDelayMs: tunables["browser.reloadPollCapS"].default * 1000 })) {
  const visible = () => visibility.visibilityState !== "hidden";
  let stopped = false, loading = false, failures = 0, visiblePending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    clearTimeout(timer);
    if (stopped || !visible()) return;
    if (loading) { visiblePending = true; return; }
    loading = true;
    try { await refresh(); failures = 0; }
    catch { failures = Math.min(failures + 1, 5); }
    finally {
      loading = false;
      if (!stopped && visible()) {
        const delay = visiblePending ? 0 : Math.min(timing().maximumDelayMs, timing().baseDelayMs * 2 ** Math.max(0, failures - 1));
        visiblePending = false;
        timer = setTimeout(() => void poll(), delay);
      }
    }
  };
  const changed = () => {
    clearTimeout(timer);
    visiblePending = false;
    if (visibility.visibilityState !== "hidden") void poll();
  };
  visibility.addEventListener("visibilitychange", changed);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", changed);
  };
}
