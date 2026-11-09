import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { sampleWorkspaceRoot } from "../server/paths.js";
import net from "node:net";
import path from "node:path";

/** The Mac companion owns this port; a sandbox backend must never take it. */
export const COMPANION_PORT = 4317;

/** Reads `--flag value` pairs; unknown flags fail so a typo is not ignored. */
export function parseFlags(argv: string[], allowed: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !allowed.includes(name))
      throw new Error(`Unknown argument ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    values[name] = value;
  }
  return values;
}

export function parsePort(value: string, flag: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`${flag} must be an integer between 1024 and 65535`);
  return port;
}

export function parseDevClientArgs(argv: string[]) {
  const { api } = parseFlags(argv, ["api"]);
  return { api: api === undefined ? 4317 : parsePort(api, "--api") };
}

/** Branch name plus a short random suffix: each plain run gets its own fixture. */
export function defaultSandboxName(
  branch = currentBranch(),
  suffix = randomBytes(2).toString("hex"),
) {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  return `${slug || "dev"}-${suffix}`;
}

function currentBranch() {
  const out = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  });
  return out.status === 0 ? out.stdout.trim() : "";
}

export function parseDevServerArgs(
  argv: string[],
  generateName: () => string = defaultSandboxName,
) {
  const { name, port } = parseFlags(argv, ["name", "port"]);
  const chosen = name ?? generateName();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/i.test(chosen))
    throw new Error("--name must be letters, digits and dashes");
  const parsed = port === undefined ? undefined : parsePort(port, "--port");
  if (parsed === COMPANION_PORT)
    throw new Error(
      `--port ${COMPANION_PORT} belongs to the Mac companion; pick another port or omit --port`,
    );
  return { name: chosen, port: parsed };
}

/** Everything the sandbox backend may write lives under `home`. */
export function sandboxLayout(repository: string, name: string) {
  const home = path.join(repository, ".local/dev", name);
  return {
    home,
    // The fixture script only accepts directories with this prefix.
    dataDir: path.join(home, `fieldwork-browser-fixture-${name}`),
    rootDir: path.join(home, "root"),
    serverFile: path.join(home, "server.json"),
  };
}

/** Copy only fictional sources; preserve a named sandbox's existing edits. */
export function writeSyntheticRoot(rootDir: string) {
  cpSync(sampleWorkspaceRoot, rootDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

/** A sandbox must not inherit the machine's cloud role, service identity or alerts. */
export function sandboxEnv(
  base: NodeJS.ProcessEnv,
  layout: { rootDir: string; dataDir: string },
  port: number,
) {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PORT: String(port),
    JOB_SEARCH_ROOT: layout.rootDir,
    JOB_SEARCH_DATA: layout.dataDir,
  };
  for (const key of [
    "FIELDWORK_NTFY_URL",
    "FIELDWORK_NOTIFICATION_URL",
    "FIELDWORK_CLOUD_ACCESS",
    "FIELDWORK_MACHINE_TOKEN_FILE",
    "FIELDWORK_RENDER_URL",
    "FIELDWORK_SERVICE_LABEL",
    "FIELDWORK_SERVICE_SCOPE",
  ])
    delete env[key];
  return env;
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Refuses a second backend on a name whose recorded pid is still alive. */
export function claimServerFile(file: string, pid: number, port: number) {
  try {
    const recorded = JSON.parse(readFileSync(file, "utf8")) as {
      pid?: number;
      port?: number;
    };
    if (typeof recorded.pid === "number" && pidAlive(recorded.pid))
      throw new Error(
        `A dev backend (pid ${recorded.pid}, port ${recorded.port}) is already running on this name; stop it or choose another --name`,
      );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(error instanceof SyntaxError)
    )
      throw error;
  }
  writeFileSync(
    file,
    JSON.stringify({ pid, port, startedAt: new Date().toISOString() }),
  );
}

export function releaseServerFile(file: string) {
  rmSync(file, { force: true });
}

/** Asks the OS for an unused loopback port. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
