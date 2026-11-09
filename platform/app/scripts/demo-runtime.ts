import express from "express";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { platformBuild, repositoryRoot } from "../server/paths.js";
import {
  freeLoopbackPort,
  parseDevServerArgs,
  sandboxLayout,
} from "./dev-options.js";
import { guardDemoNetwork } from "./demo-network.js";
import { registerDemoShell } from "./demo-shell.js";
import { writeDemoSources } from "./demo-sources.js";
import { seedDemo } from "./demo-seed.js";

export async function startDemo(
  argv: string[] = [],
  options: { staticDir?: string; browserPort?: 8931 } = {},
) {
  const { name, port: requested } = parseDevServerArgs(
    argv,
    () => `showcase-${randomBytes(3).toString("hex")}`,
  );
  const layout = sandboxLayout(repositoryRoot, `demo-${name}`);
  mkdirSync(layout.home, { recursive: true });
  writeDemoSources(layout.rootDir);
  const logFile = path.join(layout.home, "outbound-requests.jsonl");
  writeFileSync(logFile, "");
  const port = requested ?? (await freeLoopbackPort());
  if (port === 44317)
    throw new Error("The companion tunnel port is not available to the demo");
  const restore = guardDemoNetwork(logFile, [
    port,
    ...(options.browserPort === undefined ? [] : [options.browserPort]),
  ]);
  const disabled = () => {
    throw new Error("Agents are disabled in the demo.");
  };
  let workspace:
    | Awaited<ReturnType<typeof import("../server/server.js").createWorkspace>>
    | undefined;
  try {
    // Direct local construction: never the role-selecting companion/cloud entry.
    const { createWorkspace } = await import("../server/server.js");
    workspace = await createWorkspace({
      root: layout.rootDir,
      dataDir: layout.dataDir,
      port,
      connectAgent: false,
      watch: false,
      background: false,
      staticDir: options.staticDir ?? platformBuild,
      agentFixtures: {
        spawnProcess: disabled,
        claude: { query: disabled, sessionMessages: async () => disabled() },
      },
    });
    await seedDemo(workspace.store);
    const app = createDemoApp(workspace, options.staticDir ?? platformBuild);
    const server = app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    return {
      layout,
      logFile,
      url: `http://127.0.0.1:${port}`,
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          await workspace!.close();
        } finally {
          restore();
        }
      },
    };
  } catch (error) {
    try {
      await workspace?.close();
    } finally {
      restore();
    }
    throw error;
  }
}

function createDemoApp(
  workspace: Awaited<
    ReturnType<typeof import("../server/server.js").createWorkspace>
  >,
  staticDir: string,
) {
  const app = express();
  const disabledAgents = (_req: express.Request, res: express.Response) =>
    res.status(403).json({ error: "Agents are disabled in the demo." });
  app.use(
    ["/api/questions", "/api/tasks", "/api/agent/connect"],
    disabledAgents,
  );
  app.post("/api/openings/:id/prepare", disabledAgents);
  app.get("/api/agent/status", (_req, res) =>
    res.json({
      ...workspace.agent.status(),
      available: false,
      reason: "Agents are disabled in the demo.",
    }),
  );
  // This is an inspectable, read-only showcase, not a way to start workflows.
  app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.status(403).json({
        error:
          "Synthetic demo is read-only; workflows and integrations are disabled.",
      });
      return;
    }
    next();
  });
  app.get("/api/openings/:id/application", (_req, res) =>
    res.status(403).json({
      error: "Employer forms and live posting reads are disabled in the demo.",
    }),
  );
  app.get("/api/agent/models", (_req, res) =>
    res.json({ models: [], refreshedAt: null, refreshing: false, error: null }),
  );
  registerDemoShell(app, staticDir);
  app.use(workspace.app);
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "The demo could not serve this request." });
    },
  );
  return app;
}
