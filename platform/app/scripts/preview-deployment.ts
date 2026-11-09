import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { atomicWrite } from "../server/storage.js";
import { previewDirectory } from "../server/companion-preview.js";

function buildFiles(root: string, relative = ""): string[] {
  return readdirSync(path.join(root, relative)).flatMap((name) => {
    const item = path.join(relative, name);
    const stat = lstatSync(path.join(root, item));
    if (stat.isSymbolicLink())
      throw new Error("Preview build contains a symlink");
    if (stat.isDirectory()) return buildFiles(root, item);
    if (!stat.isFile()) throw new Error("Preview build contains a non-file");
    return [item];
  });
}

/** Keep hashed chunks across publications so already-open tabs can lazy-load. */
export function publishPreview(dataDir: string, stage: string) {
  const files = buildFiles(stage);
  if (
    !files.includes("index.html") ||
    !readFileSync(path.join(stage, "index.html"), "utf8").trim()
  )
    throw new Error("Preview build has no index.html");
  const directory = previewDirectory(dataDir);
  const release = randomUUID();
  const destination = path.join(directory, "releases", release);
  for (const file of files) {
    const source = path.join(stage, file);
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    if (!file.startsWith("assets/")) continue;
    const asset = path.join(directory, file);
    mkdirSync(path.dirname(asset), { recursive: true, mode: 0o700 });
    if (existsSync(asset)) {
      if (!readFileSync(asset).equals(readFileSync(source)))
        throw new Error(`Preview asset identity collision: ${file}`);
    } else atomicWrite(asset, readFileSync(source));
  }
  atomicWrite(path.join(directory, "current.json"), JSON.stringify(release));
}

interface PreviewDeployment {
  dataDir: string;
  command: (args: string[]) => void;
  read: (route: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  report: (message: string) => void;
  /** Restart the companion after publishing; needed only when its server code changed. */
  restart?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function waitForPreviewIdle(control: PreviewDeployment) {
  const deadline = control.now() + 15 * 60_000;
  let nextReport = 0;
  let probeError = "";
  while (control.now() < deadline) {
    try {
      const health = record(await control.read("/api/health"));
      const activity = record(await control.read("/api/system/activity"));
      const companion = record(await control.read("/api/companion/health"));
      probeError = "";
      if (
        health.status === "ok" &&
        !health.reloading &&
        Array.isArray(activity.remaining) &&
        activity.remaining.length === 0 &&
        companion.connected === true
      )
        return;
    } catch (error) {
      // Answers cross a slow uplink, so one slow or failed check only
      // means idleness is not verified yet, not that the publish should end.
      probeError = error instanceof Error ? error.message : String(error);
    }
    if (control.now() >= nextReport) {
      control.report(
        probeError
          ? `Status check failed (${probeError}); still waiting for verified idle work before publishing the local preview.`
          : "Waiting for verified idle cloud tasks, PDFs, scans, preparations, Greenhouse and Gmail before publishing the local preview.",
      );
      nextReport = control.now() + 10_000;
    }
    await control.sleep(1_000);
  }
  throw new Error(
    `Fieldwork did not become idle${probeError ? ` (last status check failed: ${probeError})` : ""}; preview was not activated and nothing was restarted.`,
  );
}

async function waitForPreviewConnection(control: PreviewDeployment) {
  const deadline = control.now() + 90_000;
  while (control.now() < deadline) {
    try {
      const health = record(await control.read("/api/companion/health"));
      if (health.status === "ok" && health.connected === true) return;
    } catch {
      // KeepAlive readiness precedes the SSH tunnel's authenticated probe.
    }
    await control.sleep(1_000);
  }
  throw new Error(
    "Companion did not report a connected tunnel within 90 seconds",
  );
}

export async function deployPreview(control: PreviewDeployment) {
  const directory = previewDirectory(control.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "deployment.lock");
  mkdirSync(lock, { mode: 0o700 });
  const stage = path.join(directory, `build-${randomUUID()}`);
  const pointer = path.join(directory, "current.json");
  let previous: Buffer | null = null;
  let activated = false;
  try {
    previous = existsSync(pointer) ? readFileSync(pointer) : null;
    control.command(["run", "service:status"]);
    control.command(["run", "build", "--", "--outDir", stage]);
    await waitForPreviewIdle(control);
    publishPreview(control.dataDir, stage);
    activated = true;
    // The companion reads current.json per request, so a restart (which drops
    // the user's open browser session) is only for changed companion code.
    if (control.restart) control.command(["run", "service:restart"]);
    await waitForPreviewConnection(control);
    control.report(
      `Local preview deployed: http://127.0.0.1:4317 (live cloud data), companion ${control.restart ? "restarted" : "not restarted"}. Production was not deployed or reloaded.`,
    );
  } catch (error) {
    if (activated) {
      if (previous) atomicWrite(pointer, previous);
      else rmSync(pointer, { force: true });
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
