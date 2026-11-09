import type { Express } from "express";
import { openingFormChecksPath } from "../../shared/opening-form-check.js";
import { startFormCheckPass } from "../autofill/form-checks.js";
import type { WorkspaceContext } from "../server.js";
import { withContext } from "./context.js";

export function registerOpeningFormChecks(app: Express, ctx: WorkspaceContext) {
  app.post(
    openingFormChecksPath,
    withContext(ctx, ({ store, publish }, _req, res) => {
      res.status(202).json(startFormCheckPass(store, () => publish("state")));
    }),
  );
}
