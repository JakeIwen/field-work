import { spawnSync } from "node:child_process";
import path from "node:path";
import { readCompanionConfig } from "../server/companion-config.js";
import { readFileSync } from "node:fs";
import {
  validateServiceConfig,
  type ServiceConfig,
} from "../server/launchd.js";
import { dataDirectory, platformRoot } from "../server/paths.js";
import { deployPreview } from "./preview-deployment.js";

try {
  if (process.platform !== "darwin")
    throw new Error(
      "Local preview deployment requires the existing Mac companion",
    );
  readCompanionConfig(path.join(dataDirectory, "companion.json"));
  const service: ServiceConfig = JSON.parse(
    readFileSync(path.join(dataDirectory, "launchd/service.json"), "utf8"),
  );
  validateServiceConfig(service);
  if (service.port !== 4317)
    throw new Error(
      "Local preview requires the installed companion on port 4317",
    );
  await deployPreview({
    dataDir: dataDirectory,
    restart: process.argv.includes("--restart"),
    command: (args) => {
      const result = spawnSync("npm", args, {
        cwd: platformRoot,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `Preview ${args.join(" ")} failed (${result.status ?? result.signal})`,
        );
    },
    read: async (route) => {
      const response = await fetch(`http://127.0.0.1:4317${route}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok)
        throw new Error(`Preview probe ${route} failed (${response.status})`);
      return response.json();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => performance.now(),
    report: (message) => console.error(message),
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Local preview deployment failed",
  );
  process.exitCode = 1;
}
