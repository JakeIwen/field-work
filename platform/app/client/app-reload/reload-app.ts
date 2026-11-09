import { tunableValue, type TunableSettings } from "../../shared/tunables";
import type { AppHealth, AppReloadReceipt, AppReloadStatus } from "../../shared/app-reload";
import { api } from "../workspace/api";

export type ReloadActions = {
  request: (whenIdle?: boolean) => Promise<AppReloadReceipt>;
  health: () => Promise<AppHealth>;
  wait: () => Promise<void>;
  now: () => number;
  reloadPage: () => void;
  onStatus?: (status: AppReloadStatus) => void;
  signal?: AbortSignal;
};
export function browserReloadTiming(settings: () => TunableSettings = () => ({})): ReloadActions { return {
  request: (whenIdle = false) => api("/api/system/reload", { whenIdle }),
  health: () => api("/api/health", undefined, undefined, { signal: AbortSignal.timeout(tunableValue(settings(), "browser.reloadHealthTimeoutS") * 1000) }),
  wait: () => new Promise(resolve => setTimeout(resolve, tunableValue(settings(), "browser.reloadHealthIntervalMs"))),
  now: () => performance.now(),
  reloadPage: () => window.location.reload(),
}; }
export const browserReloadActions = browserReloadTiming();

export async function waitForAppReload(receipt: AppReloadReceipt, actions: ReloadActions) {
  if ((!receipt.reloading && !receipt.waiting) || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1)
    throw new Error("The backend did not acknowledge the reload. Try again.");
  let deadline = receipt.waiting && !receipt.reloading ? Infinity : actions.now() + 180000;
  while (actions.now() < deadline) {
    actions.signal?.throwIfAborted();
    await actions.wait();
    let health: AppHealth;
    try { health = await actions.health(); }
    catch {
      if (!Number.isFinite(deadline)) deadline = actions.now() + 180000;
      continue;
    }
    actions.signal?.throwIfAborted();
    if (health.status === "ok" && Number.isSafeInteger(health.pid) && health.pid > 0 && health.pid !== receipt.pid && !health.reloading) {
      actions.reloadPage();
      return;
    }
    if (health.reload) {
      actions.onStatus?.(health.reload);
      if (health.reload.waiting) deadline = Infinity;
      else if (!health.reload.reloading && receipt.waiting) return; // The queued reload was cancelled.
    }
    if (health.reloading && !Number.isFinite(deadline)) deadline = actions.now() + 180000;
  }
  throw new Error("The backend has not returned after three minutes. Check the local service, then retry.");
}

export async function reloadApp(actions: ReloadActions = browserReloadActions, whenIdle = false) {
  await waitForAppReload(await actions.request(whenIdle), actions);
}
