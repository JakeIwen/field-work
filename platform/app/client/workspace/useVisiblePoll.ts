import { useEffect, useRef } from "react";

export type VisiblePoll<T> = {
  /** Polling is off, and nothing is fetched, while false. */
  enabled: boolean;
  intervalMs: number;
  /** Whether to keep polling until the first answer says otherwise. */
  continueInitially: boolean;
  /** One read; throw to report that the endpoint is unavailable. */
  poll: (signal: AbortSignal) => Promise<T>;
  /** Takes a successful answer and returns whether to schedule the next poll. */
  onResult: (value: T) => boolean;
  /** Called when a read throws; the previous continue decision stands. */
  onError?: () => void;
  /** Changing any of these restarts polling with a fresh first read. */
  deps?: readonly unknown[];
};

/**
 * Polls while the tab is visible. A hidden tab schedules nothing (the timer chain simply stops),
 * and becoming visible or focused reads immediately and resumes the interval. Used for live
 * status that must not keep a background tab's requests going.
 */
export function useVisiblePoll<T>(options: VisiblePoll<T>) {
  const latest = useRef(options);
  latest.current = options;
  const { enabled, intervalMs, continueInitially, deps = [] } = options;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let fetching = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let continuePolling = continueInitially;
    const schedule = () => {
      if (document.visibilityState !== 'hidden') timer = setTimeout(check, intervalMs);
    };
    const check = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await latest.current.poll(controller.signal);
        if (!controller.signal.aborted) {
          continuePolling = latest.current.onResult(value);
          if (continuePolling) schedule();
        }
      } catch {
        if (!controller.signal.aborted) {
          latest.current.onError?.();
          if (continuePolling) schedule();
        }
      } finally { fetching = false; }
    };
    const refreshVisible = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== 'hidden') void check();
    };
    if (document.visibilityState !== 'hidden') void check();
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    return () => {
      if (timer) clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
    };
  }, [enabled, intervalMs, continueInitially, ...deps]);
}
