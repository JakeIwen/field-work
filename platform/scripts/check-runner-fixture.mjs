import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [mode, pidFile, heartbeat] = process.argv.slice(2);

if (mode === "grandchild") {
  process.on("SIGTERM", () => {});
  writeFileSync(pidFile, String(process.pid));
  appendFileSync(heartbeat, ".");
  process.send?.("ready");
  setInterval(() => appendFileSync(heartbeat, "."), 15);
} else {
  const child = spawn(
    process.execPath,
    [import.meta.filename, "grandchild", pidFile, heartbeat],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  child.unref();
  if (mode === "fail") child.once("message", () => process.exit(9));
  else {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
}
