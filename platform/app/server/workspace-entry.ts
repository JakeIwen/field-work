import path from "node:path";
import { existsSync } from "node:fs";
import { workspaceModes } from "../shared/cloud-connection.js";
import { createWorkspace } from "./server.js";
import type { WorkspaceOptions } from "./task-kinds/workspace-runtime.js";
import { resolveCloudAccessConfig } from "./cloud-access.js";
import { readMachineToken } from "./cloud-ingress.js";
import { readCompanionConfig } from "./companion-config.js";
import { createCompanion } from "./companion.js";
import { createRemoteRenderHandler } from "./remote-render-handler.js";

/** The existing boot registration switches roles without running a second Store. */
export async function createConfiguredWorkspace(options: WorkspaceOptions) {
  const companionFile = path.join(options.dataDir, "companion.json");
  const cloudAccess = resolveCloudAccessConfig(process.env);
  if (existsSync(companionFile)) {
    if (cloudAccess)
      throw new Error("Cloud and companion modes cannot be combined");
    if (!options.shutdown)
      throw new Error("Companion shutdown must be configured");
    const config = readCompanionConfig(companionFile);
    const companion = createCompanion({
      ...options,
      shutdown: options.shutdown,
      config,
      renderHandler: createRemoteRenderHandler({
        root: options.root,
        dataDir: options.dataDir,
        token: config.machineToken,
      }),
    });
    return { ...companion, mode: workspaceModes.companion };
  }
  const workspace = await createWorkspace({
    ...options,
    cloudAccess,
    ...(cloudAccess
      ? {
          machineToken: readMachineToken(
            process.env.FIELDWORK_MACHINE_TOKEN_FILE,
          ),
        }
      : {}),
  });
  return {
    ...workspace,
    mode: cloudAccess ? workspaceModes.cloud : workspaceModes.local,
  };
}
