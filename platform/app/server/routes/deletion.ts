import type { Express } from "express";
import type { WorkspaceContext } from "../server.js";
import { withContext } from "./context.js";
import { deleteRecord, previewDeletion } from "../record-deletion.js";
import { deleteJournalRecords } from "../record-deletion-leaves.js";
import type { DeletionKind } from "../../shared/record-deletion.js";

export function register(app: Express, ctx: WorkspaceContext) {
  app.get(
    "/api/records/:kind/:id/deletion",
    withContext(ctx, (ctx, req, res) =>
      res.json(
        previewDeletion(
          ctx.store,
          String(req.params.kind) as DeletionKind,
          String(req.params.id),
          ctx,
        ),
      ),
    ),
  );
  app.delete(
    "/api/journal",
    withContext(ctx, (ctx, req, res) =>
      ctx.changed(res, deleteJournalRecords(ctx.store, req.body)),
    ),
  );
  app.delete(
    "/api/records/:kind/:id",
    withContext(ctx, async (ctx, req, res) => {
      const { reindex, ...result } = deleteRecord(
        ctx.store,
        String(req.params.kind) as DeletionKind,
        String(req.params.id),
        req.body?.token,
        ctx,
      );
      if (reindex) await ctx.reindex();
      ctx.changed(res, result);
    }),
  );
}
