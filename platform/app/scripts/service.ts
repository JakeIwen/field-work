import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  lstatSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  platformRoot,
  repositoryRoot,
  dataDirectory,
  platformBuild,
} from "../server/paths.js";
import {
  serviceLabel,
  serviceDomain,
  serviceDestination,
  servicePlist,
  validateServiceConfig,
  type ServiceConfig,
} from "../server/launchd.js";
import {
  serviceEndpoint,
  serviceEnabled,
  startService,
  waitForHealthy,
  type LaunchdJob,
} from "./service-control.js";

const action = process.argv[2] ?? "status";
const directory = path.join(dataDirectory, "launchd");
const manifest = path.join(directory, "service.json");
const preparedPlist = path.join(directory, `${serviceLabel}.plist`);
const own = os.userInfo();
if (process.platform !== "darwin")
  throw new Error("This service manager requires macOS launchd");
if (own.uid === 0)
  throw new Error(
    "Run npm service commands as your normal user. Only the specific launchd installation/control commands use sudo.",
  );
let config: ServiceConfig;
if (["prepare", "install"].includes(action)) {
  const scope = process.argv.includes("--login") ? "login" : "boot";
  config = {
    label: serviceLabel,
    scope,
    uid: own.uid,
    username: own.username,
    home: own.homedir,
    node: process.execPath,
    loader: fileURLToPath(import.meta.resolve("tsx")),
    platform: path.resolve(platformRoot),
    root: repositoryRoot,
    data: dataDirectory,
    port: Number(process.env.PORT ?? 4317),
  };
} else {
  if (!existsSync(manifest))
    throw new Error(
      "Service is not prepared. Run npm run service:install (or service:install -- --login).",
    );
  config = JSON.parse(readFileSync(manifest, "utf8"));
}
validateServiceConfig(config);
if (
  config.uid !== own.uid ||
  config.root !== repositoryRoot ||
  config.data !== dataDirectory
)
  throw new Error("Service configuration belongs to another user or data root");
const domain = serviceDomain(config),
  target = `${domain}/${serviceLabel}`,
  destination = serviceDestination(config);
const system = config.scope === "boot";
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${config.port}`;
function command(program: string, args: string[], elevate = false) {
  const result = spawnSync(
    elevate ? "/usr/bin/sudo" : program,
    elevate ? [program, ...args] : args,
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(program)} ${args[0]} failed (${result.status ?? result.signal})`,
    );
}
function inspect(timeoutMs?: number): LaunchdJob {
  const result = spawnSync("/bin/launchctl", ["print", target], {
    encoding: "utf8",
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = (result.stderr ?? "") + (result.stdout ?? "");
    if (/Could not find service|Could not find domain/.test(reason))
      return { loaded: false, pid: null, raw: reason };
    throw new Error(`Cannot inspect ${target}: ${reason.trim()}`);
  }
  return {
    loaded: true,
    pid: Number(result.stdout.match(/^\s*pid = (\d+)/m)?.[1]) || null,
    raw: result.stdout,
  };
}
function enabled() {
  return serviceEnabled(
    execFileSync("/bin/launchctl", ["print-disabled", domain], {
      encoding: "utf8",
    }),
    serviceLabel,
  );
}
async function health(timeoutMs = 5000) {
  try {
    const response = await fetch(
      `${base}${serviceEndpoint(runtime(), "health")}`,
      {
        // Cold Node HTTP initialization can exceed one second on a healthy host.
        signal: AbortSignal.timeout(Math.max(0, Math.floor(timeoutMs))),
      },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
function runtime() {
  try {
    return JSON.parse(
      readFileSync(path.join(config.data, "runtime.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
function assertInstalledIdentity() {
  if (!existsSync(destination)) return;
  if (lstatSync(destination).isSymbolicLink())
    throw new Error("Refusing to overwrite a symlinked service plist");
  const installed = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", destination],
      { encoding: "utf8" },
    ),
  );
  if (
    installed.Label !== serviceLabel ||
    installed.EnvironmentVariables?.JOB_SEARCH_ROOT !== config.root ||
    installed.EnvironmentVariables?.JOB_SEARCH_DATA !== config.data ||
    (system && installed.UserName !== config.username)
  )
    throw new Error(
      "An existing service with this label belongs to another installation; no changes made",
    );
}
function prepare() {
  if (existsSync(manifest)) {
    const prior: ServiceConfig = JSON.parse(readFileSync(manifest, "utf8"));
    validateServiceConfig(prior);
    if (prior.scope !== config.scope && existsSync(serviceDestination(prior)))
      throw new Error(
        "Uninstall the existing service before switching boot/login scope",
      );
  }
  if (!existsSync(path.join(platformBuild, "index.html")))
    throw new Error("Build the application first: npm run build");
  for (const p of [
    config.node,
    config.loader,
    path.join(config.platform, "app/server/index.ts"),
  ])
    if (!existsSync(p)) throw new Error(`Required runtime file missing: ${p}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(preparedPlist, servicePlist(config), { mode: 0o600 });
  execFileSync("/usr/bin/plutil", ["-lint", preparedPlist], {
    stdio: "inherit",
  });
  writeFileSync(manifest, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  for (const name of ["launchd.stdout.log", "launchd.stderr.log"]) {
    const p = path.join(config.data, name);
    if (!existsSync(p)) writeFileSync(p, "", { mode: 0o600 });
  }
  console.log(
    `Prepared ${config.scope === "boot" ? "boot-time LaunchDaemon (runs as " + config.username + ")" : "login LaunchAgent"}\nPlist: ${preparedPlist}\nDestination: ${destination}`,
  );
}
async function stopOwnedProcess() {
  const live = await health();
  if (!live) return false;
  const saved = runtime();
  if (!saved || saved.pid !== live.pid || saved.root !== config.root)
    throw new Error(
      `Port ${config.port} belongs to an unrecognized process; it was not stopped`,
    );
  const session = await (
    await fetch(`${base}${serviceEndpoint(saved, "session")}`, {
      signal: AbortSignal.timeout(2000),
    })
  ).json();
  const response = await fetch(`${base}${serviceEndpoint(saved, "stop")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    },
    body: "{}",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    throw new Error("The existing server refused a graceful shutdown");
  for (let i = 0; i < 80; i++) {
    const current = await health();
    if (!current || current.pid !== live.pid) return true;
    await sleep(250);
  }
  throw new Error(
    "Existing server did not stop; no second server was launched",
  );
}
async function waitHealthy(previousPid?: number) {
  return waitForHealthy(
    {
      inspect,
      health,
      runtime,
      sleep,
      now: () => performance.now(),
      root: config.root,
      serviceLabel,
      onProgress: (elapsedMs, limitMs) =>
        console.error(
          `Waiting for service readiness: ${Math.floor(elapsedMs / 1000)}s elapsed (limit ${limitMs / 1000}s)`,
        ),
      onTimeout: (job) =>
        new Error(
          job.loaded
            ? `Service did not become healthy. Inspect ${path.join(config.data, "launchd.stderr.log")} and run npm run service:status`
            : "Service is installed but unloaded. Run npm run service:start from a normal Terminal, then npm run service:status.",
        ),
    },
    previousPid,
  );
}
async function restoreDetached() {
  if (await health()) return;
  const log = path.join(config.data, "server.log");
  const fs = await import("node:fs");
  const output = fs.openSync(log, "a", 0o600);
  const child = spawn(
    config.node,
    [
      "--import",
      config.loader,
      path.join(config.platform, "app/server/index.ts"),
    ],
    {
      cwd: config.platform,
      env: {
        ...process.env,
        PORT: String(config.port),
        JOB_SEARCH_ROOT: config.root,
        JOB_SEARCH_DATA: config.data,
      },
      detached: true,
      stdio: ["ignore", output, output],
    },
  );
  await once(child, "spawn");
  child.unref();
  fs.closeSync(output);
  console.error(
    `Restored detached server after installation failure (PID ${child.pid}); persistence is not verified.`,
  );
}
async function start(restart = false) {
  if (!existsSync(destination))
    throw new Error(
      "Service plist is not installed. Run npm run service:install first.",
    );
  assertInstalledIdentity();
  const result = await startService(
    {
      inspect,
      enabled,
      enable: () => command("/bin/launchctl", ["enable", target], system),
      stopOwnedProcess,
      bootstrap: () =>
        command("/bin/launchctl", ["bootstrap", domain, destination], system),
      kickstart: () => command("/bin/launchctl", ["kickstart", target], system),
      waitHealthy,
    },
    restart,
  );
  console.log(
    `Fieldwork is running under launchd (PID ${result.live.pid}): ${base}`,
  );
}
async function stop() {
  assertInstalledIdentity();
  command("/bin/launchctl", ["disable", target], system);
  if (inspect().loaded) command("/bin/launchctl", ["bootout", target], system);
  console.log(
    "Service stopped and disabled until service:start. Personal data retained.",
  );
}
try {
  if (action === "prepare") prepare();
  else if (action === "install") {
    prepare();
    assertInstalledIdentity();
    // Install permissions are obtained before touching the currently running server.
    if (system)
      command(
        "/usr/bin/install",
        ["-o", "root", "-g", "wheel", "-m", "644", preparedPlist, destination],
        true,
      );
    else {
      mkdirSync(path.dirname(destination), { recursive: true });
      const tmp = `${destination}.${randomUUID()}.tmp`;
      try {
        copyFileSync(preparedPlist, tmp);
        chmodSync(tmp, 0o644);
        renameSync(tmp, destination);
      } finally {
        if (existsSync(tmp)) unlinkSync(tmp);
      }
    }
    let stopped = false;
    try {
      command("/bin/launchctl", ["enable", target], system);
      if (inspect().loaded) {
        command("/bin/launchctl", ["bootout", target], system);
        stopped = true;
      }
      stopped = (await stopOwnedProcess()) || stopped;
      command("/bin/launchctl", ["bootstrap", domain, destination], system);
      const result = await waitHealthy();
      console.log(
        `Installed and verified ${target} (PID ${result.live.pid}). ${base}`,
      );
    } catch (error) {
      if (stopped && !inspect().loaded) await restoreDetached();
      throw error;
    }
  } else if (action === "start") await start();
  else if (action === "restart") await start(true);
  else if (action === "stop") await stop();
  else if (action === "uninstall") {
    await stop();
    if (existsSync(destination))
      system
        ? command("/bin/rm", ["--", destination], true)
        : unlinkSync(destination);
    console.log(
      "Removed the startup plist. Repository, database and logs retained.",
    );
  } else if (action === "status") {
    assertInstalledIdentity();
    const job = inspect(),
      live = await health(),
      saved = runtime(),
      installed = existsSync(destination),
      startupEnabled = enabled(),
      healthy = Boolean(
        installed &&
        startupEnabled &&
        job.loaded &&
        job.pid &&
        live?.pid === job.pid &&
        saved?.pid === job.pid &&
        saved?.root === config.root &&
        saved?.serviceLabel === serviceLabel,
      );
    console.log(
      JSON.stringify(
        {
          scope: config.scope,
          target,
          installed,
          enabled: startupEnabled,
          loaded: job.loaded,
          pid: job.pid,
          healthy,
          url: base,
          stdout: path.join(config.data, "launchd.stdout.log"),
          stderr: path.join(config.data, "launchd.stderr.log"),
        },
        null,
        2,
      ),
    );
    if (!healthy) process.exitCode = 1;
  } else if (action === "verify") {
    assertInstalledIdentity();
    if (!existsSync(destination) || !enabled())
      throw new Error(
        "Start the installed service before verifying automatic restart.",
      );
    const before = await waitHealthy();
    // Graceful exit simulates an ordinary server termination; KeepAlive must recover it.
    await stopOwnedProcess();
    const after = await waitHealthy(before.live.pid);
    console.log(
      JSON.stringify(
        {
          verified: true,
          oldPid: before.live.pid,
          newPid: after.live.pid,
          automaticRestart: true,
          url: base,
        },
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Use prepare, install, start, stop, restart, status, verify or uninstall",
    );
} catch (error: any) {
  console.error(error.message);
  if (["EPERM", "EACCES"].includes(error.code))
    console.error(
      `This process cannot ${action} the startup service. From ${platformRoot} in your normal Terminal, run: npm run service:${action}`,
    );
  process.exitCode = 1;
}
