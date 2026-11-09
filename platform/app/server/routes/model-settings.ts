import type { Express, Request, Response } from "express";
import { validateModelPreferences } from "../model-preferences.js";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";
import { withContext } from "./context.js";

function getModels({ agent }: WorkspaceContext, _req: Request, res: Response) {
  void agent.warmModels().catch(() => {});
  res.json(agent.modelCatalogStatus());
}

function saveModels(
  { agent, store, changed, version }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const body = req.body ?? {};
  const old = store.settings();
  if (version(body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed in another tab. Reload before saving model choices.",
    );
  const preferences = validateModelPreferences(
    body.codexModels,
    body.codexEfforts,
    old,
    agent.modelCatalogStatus(),
  );
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      ...preferences,
      version: old.version + 1,
    }),
  );
}

export function registerModelSettingsRoutes(
  app: Express,
  ctx: WorkspaceContext,
) {
  app.get("/api/agent/models", withContext(ctx, getModels));
  app.post("/api/settings/models", withContext(ctx, saveModels));
}
