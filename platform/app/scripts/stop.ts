import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDirectory as dataDir } from "../server/paths.js";
import { serviceEndpoint } from "./service-control.js";
import {
  serviceDestination,
  validateServiceConfig,
} from "../server/launchd.js";
const file = path.join(dataDir, "runtime.json");
if (!existsSync(file)) {
  const manifest = path.join(dataDir, "launchd/service.json");
  if (existsSync(manifest)) {
    const service = JSON.parse(readFileSync(manifest, "utf8"));
    validateServiceConfig(service);
    if (existsSync(serviceDestination(service))) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(import.meta.resolve("tsx")),
          fileURLToPath(new URL("./service.ts", import.meta.url)),
          "stop",
        ],
        { stdio: "inherit" },
      );
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
  }
  console.log("No running app is recorded.");
  process.exit(0);
}
const saved = JSON.parse(readFileSync(file, "utf8"));
const { pid, port, serviceLabel } = saved;
if (serviceLabel === "local.fieldwork") {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      fileURLToPath(import.meta.resolve("tsx")),
      fileURLToPath(new URL("./service.ts", import.meta.url)),
      "stop",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
if (!Number.isSafeInteger(pid) || pid < 2)
  throw new Error("Invalid recorded PID");
let health: any;
try {
  health = await (
    await fetch(`http://127.0.0.1:${port}${serviceEndpoint(saved, "health")}`, {
      signal: AbortSignal.timeout(3000),
    })
  ).json();
} catch {}
if (health?.status !== "ok" || health.pid !== pid)
  throw new Error(
    "Recorded PID does not identify the running local app. No process was stopped.",
  );
const { csrfToken } = await (
  await fetch(`http://127.0.0.1:${port}${serviceEndpoint(saved, "session")}`)
).json();
const response = await fetch(
  `http://127.0.0.1:${port}${serviceEndpoint(saved, "stop")}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: "{}",
  },
);
if (!response.ok)
  throw new Error(
    "The application refused to stop. Use Ctrl-C in the terminal that started it.",
  );
console.log(`Stopped job-search workspace (PID ${pid}).`);
