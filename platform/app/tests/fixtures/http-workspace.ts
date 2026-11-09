import path from "node:path";
import type { WorkspaceOptions } from "../../server/task-kinds/workspace-runtime.js";
import { createWorkspace } from "../../server/server.js";
import { listenOnEphemeralPort } from "./ephemeral-port.js";

export async function openFixtureWorkspace(
  root: string,
  dataDir = path.join(root, ".local/data"),
  agentFixtures?: WorkspaceOptions["agentFixtures"],
) {
  const { server, port } = await listenOnEphemeralPort();
  let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await workspace?.close();
      }
    })());
  try {
    workspace = await createWorkspace({
      root,
      dataDir,
      port,
      watch: false,
      connectAgent: false,
      agentFixtures,
    });
    server.on("request", workspace.app);
    const base = `http://127.0.0.1:${port}`;
    const { csrfToken } = await (await fetch(base + "/api/session")).json();
    return {
      ...workspace,
      base,
      get: (route: string) => fetch(base + route),
      post: (route: string, body: unknown = {}, method = "POST") =>
        fetch(base + route, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify(body),
        }),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Workspace fixture initialization and cleanup failed",
      );
    }
    throw error;
  }
}
