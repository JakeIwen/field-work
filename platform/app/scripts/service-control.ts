import {
  workspaceModes,
  type WorkspaceMode,
} from "../shared/cloud-connection.js";

export type LaunchdJob = {
  loaded: boolean;
  pid: number | null;
  raw: string;
};

export type HealthyService = {
  job: LaunchdJob;
  live: { pid: number };
};

export type ServiceRuntime = {
  pid?: number;
  root?: string;
  serviceLabel?: string;
  mode?: WorkspaceMode;
};

export function serviceEndpoint(
  runtime: ServiceRuntime | null,
  operation: "health" | "session" | "stop",
) {
  if (
    runtime?.mode !== undefined &&
    !Object.values(workspaceModes).includes(runtime.mode)
  )
    throw new Error("Unknown Fieldwork runtime mode");
  if (runtime?.mode === workspaceModes.companion)
    return `/api/companion/${operation}`;
  return operation === "stop" ? "/api/system/stop" : `/api/${operation}`;
}

export const READINESS_TIMEOUT_MS = 180_000;
const READINESS_RETRY_MS = 250;
const READINESS_PROGRESS_MS = 10_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

type ServiceControl = {
  inspect(): LaunchdJob;
  enabled(): boolean;
  enable(): void;
  stopOwnedProcess(): Promise<boolean>;
  bootstrap(): void;
  kickstart(): void;
  waitHealthy(previousPid?: number): Promise<HealthyService>;
};

export type ReadinessWait = {
  inspect(timeoutMs: number): LaunchdJob;
  health(timeoutMs: number): Promise<{ pid: number } | null>;
  runtime(): ServiceRuntime | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  root: string;
  serviceLabel: string;
  onProgress?(elapsedMs: number, limitMs: number): void;
  onTimeout(job: LaunchdJob): Error;
};

export async function waitForHealthy(
  control: ReadinessWait,
  previousPid?: number,
): Promise<HealthyService> {
  const started = control.now();
  const deadline = started + READINESS_TIMEOUT_MS;
  let nextProgress = started;
  let lastJob: LaunchdJob | null = null;

  const progress = () => {
    const current = control.now();
    if (current < nextProgress) return;
    control.onProgress?.(Math.max(0, current - started), READINESS_TIMEOUT_MS);
    nextProgress = current + READINESS_PROGRESS_MS;
  };

  progress();
  while (control.now() < deadline) {
    const job = control.inspect(
      Math.max(1, Math.floor(deadline - control.now())),
    );
    lastJob = job;
    progress();
    if (control.now() >= deadline) break;

    const remainingForHealth = deadline - control.now();
    const live = await control.health(
      Math.min(
        HEALTH_PROBE_TIMEOUT_MS,
        Math.max(0, Math.floor(remainingForHealth)),
      ),
    );
    progress();
    if (control.now() >= deadline) break;

    const saved = control.runtime();
    progress();
    if (control.now() >= deadline) break;

    if (
      job.loaded &&
      job.pid &&
      live?.pid === job.pid &&
      saved?.pid === job.pid &&
      saved?.serviceLabel === control.serviceLabel &&
      saved?.root === control.root &&
      (!previousPid || job.pid !== previousPid)
    )
      return { job, live };

    const remainingForSleep = deadline - control.now();
    const sleepMs = Math.min(READINESS_RETRY_MS, Math.floor(remainingForSleep));
    if (sleepMs <= 0) break;
    await control.sleep(sleepMs);
    progress();
  }

  throw control.onTimeout(lastJob ?? control.inspect(1));
}

export async function startService(control: ServiceControl, restart = false) {
  const job = control.inspect();
  if (!control.enabled()) control.enable();
  if (restart && job.loaded) {
    const before = await control.waitHealthy();
    // Keep the registration loaded so KeepAlive can replace the exiting worker.
    await control.stopOwnedProcess();
    return control.waitHealthy(before.live.pid);
  }
  if (!job.loaded) {
    await control.stopOwnedProcess();
    control.bootstrap();
  } else if (!job.pid) control.kickstart();
  return control.waitHealthy();
}

export function serviceEnabled(output: string, label: string) {
  const prefix = `${JSON.stringify(label)} => `;
  const line = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix));
  if (!line) return true;
  const value = line.slice(prefix.length);
  if (value === "enabled" || value === "false") return true;
  if (value === "disabled" || value === "true") return false;
  throw new Error(`Cannot determine whether ${label} is enabled: ${value}`);
}
