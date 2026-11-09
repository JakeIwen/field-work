import type { Request, Response } from "express";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";
import { validateParallelPreparations } from "../preparation-settings.js";

export function savePreparationSettings(
  { store, changed, version, preparation }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed. Use the current value before saving parallel preparations.",
    );
  const parallelPreparations = validateParallelPreparations(
    req.body.parallelPreparations,
  );
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      parallelPreparations,
      version: old.version + 1,
    }),
  );
  preparation?.wake();
}
