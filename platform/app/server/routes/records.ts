import type { Express, Request } from "express";
import type { WorkspaceContext } from "../server.js";
import type { CatalogKind, CatalogSort } from "../../shared/record-catalog.js";
import type {
  ActivityArchiveScope,
  ActivityLevel,
} from "../../shared/activity.js";
import { withContext } from "./context.js";
import { HttpError } from "../storage.js";
import { catalogRecords } from "../record-catalog.js";
import { recordDetail } from "../record-detail.js";
import { activityLog } from "../activity-log.js";
import { archiveJournalEntries } from "../journal-archive.js";

function parameter(req: Request, name: string) {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new HttpError(400, `Invalid ${name} parameter`);
  return value;
}
function entities(req: Request) {
  const value = req.query.entity;
  if (value === undefined) return undefined;
  if (typeof value === "string") return [value];
  if (
    Array.isArray(value) &&
    value.every((id): id is string => typeof id === "string")
  )
    return value;
  throw new HttpError(400, "Invalid entity parameter");
}

export function register(app: Express, ctx: WorkspaceContext) {
  app.get(
    "/api/records",
    withContext(ctx, ({ store }, req, res) => {
      const limit = parameter(req, "limit");
      res.json(
        catalogRecords(store, {
          kind: parameter(req, "kind") as CatalogKind | undefined,
          q: parameter(req, "q"),
          sort: parameter(req, "sort") as CatalogSort | undefined,
          cursor: parameter(req, "cursor"),
          limit: limit === undefined ? undefined : Number(limit),
        }),
      );
    }),
  );
  app.get(
    "/api/records/:kind/:id",
    withContext(ctx, ({ store }, req, res) => {
      res.json(
        recordDetail(store, String(req.params.kind), String(req.params.id)),
      );
    }),
  );
  app.get(
    "/api/activity",
    withContext(ctx, ({ store }, req, res) => {
      const limit = parameter(req, "limit");
      res.json(
        activityLog(store, {
          q: parameter(req, "q"),
          workflow: parameter(req, "workflow"),
          level: parameter(req, "level") as ActivityLevel | undefined,
          entity: entities(req),
          archived: parameter(req, "archived") as
            ActivityArchiveScope | undefined,
          cursor: parameter(req, "cursor"),
          limit: limit === undefined ? undefined : Number(limit),
        }),
      );
    }),
  );
  app.post(
    "/api/journal/archive",
    withContext(ctx, (ctx, req, res) =>
      ctx.changed(res, archiveJournalEntries(ctx.store, req.body)),
    ),
  );
}
