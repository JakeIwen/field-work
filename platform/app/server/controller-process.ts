import { execFileSync } from "node:child_process";

export type ProcessIdentity = { startedAt: string; uid: number };
export type ControllerProcess =
  | { state: "dead" }
  | { state: "alive"; identity?: ProcessIdentity }
  | { state: "unknown"; reason: string };
export type InspectControllerProcess = (pid: number) => ControllerProcess;

export function parseProcessIdentity(
  output: string,
): ProcessIdentity | undefined {
  const match = output
    .trim()
    .match(
      /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)$/,
    );
  if (!match) return;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[1]);
  const [day, hour, minute, second, year, uid] = match.slice(2).map(Number);
  if (
    month < 0 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !Number.isSafeInteger(uid)
  )
    return;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  )
    return;
  return { startedAt: date.toISOString(), uid };
}

function signalState(pid: number): ControllerProcess {
  try {
    process.kill(pid, 0);
    return { state: "alive" };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown error";
    return code === "ESRCH"
      ? { state: "dead" }
      : { state: "unknown", reason: code };
  }
}

/** Read only process identity, never command arguments or environment contents. */
export function inspectControllerProcess(pid: number): ControllerProcess {
  const signal = signalState(pid);
  if (signal.state === "dead") return signal;
  try {
    const output = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "uid="],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 4096,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const identity = parseProcessIdentity(output);
    if (identity) return { state: "alive", identity };
  } catch {
    /* Process exit and restricted inspection are distinguished below. */
  }
  const current = signalState(pid);
  if (current.state === "dead") return current;
  return current.state === "alive"
    ? current
    : { state: "unknown", reason: "process identity inspection unavailable" };
}
