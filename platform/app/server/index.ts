import { workspaceModes } from "../shared/cloud-connection.js";
import { diagnosticLog, setDiagnosticRole } from "./diagnostic-log.js";
import path from "node:path";
import { repositoryRoot as root, dataDirectory as dataDir } from "./paths.js";
import { createConfiguredWorkspace } from "./workspace-entry.js";
import { atomicWrite } from "./storage.js";
import { trackResponses } from "./http-drain.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be an integer between 1024 and 65535");
let stop = () => {};
const workspace = await createConfiguredWorkspace({
  root,
  dataDir,
  port,
  shutdown: () => stop(),
});
setDiagnosticRole(
  workspace.mode === workspaceModes.companion
    ? "mac-companion"
    : "cloud-backend",
);
const runtime = path.join(dataDir, "runtime.json");
const server = workspace.app.listen(port, "127.0.0.1", () => {
  atomicWrite(
    runtime,
    JSON.stringify({
      pid: process.pid,
      port,
      root,
      mode: workspace.mode,
      serviceLabel: process.env.FIELDWORK_SERVICE_LABEL ?? null,
      serviceScope: process.env.FIELDWORK_SERVICE_SCOPE ?? null,
      startedAt: new Date().toISOString(),
    }),
  );
  diagnosticLog("info", "server", "Workspace listening", {
    mode: workspace.mode,
    port,
    dataDirectory: dataDir,
    ...(workspace.mode === workspaceModes.companion
      ? { storage: "Companion data directory is not the live database" }
      : {}),
  });
});
// Answers can take seconds to cross the tunnel and a slow uplink.
// Keep idle sockets longer than clients pool them (Node's agent 5 s, fetch just
// under the advertised timeout) so this side never closes one about to be reused.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
const drainResponses = trackResponses(server);
server.on("error", async (e) => {
  diagnosticLog("error", "server", "Server failed", {}, e);
  await workspace.close();
  process.exitCode = 1;
});
let stopping = false;
stop = () => {
  if (stopping) return;
  stopping = true;
  // Finish in-flight responses before the workspace, or a companion's cloud
  // tunnel, closes under them; 5 s leaves room inside the 20 s stop timeouts.
  void drainResponses(5_000)
    .then(() => workspace.close())
    .then(() => {
      if (
        existsSync(runtime) &&
        JSON.parse(readFileSync(runtime, "utf8")).pid === process.pid
      )
        unlinkSync(runtime);
      process.exit(0);
    });
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
