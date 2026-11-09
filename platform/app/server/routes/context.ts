import type { Request, Response } from "express";
import type { WorkspaceContext } from "../server.js";

type ContextHandler = (
  ctx: WorkspaceContext,
  req: Request,
  res: Response,
) => unknown;

export function withExportContext(
  ctx: WorkspaceContext,
  handler: ContextHandler,
) {
  return withContext(ctx, (current, req, res) => {
    current.store.flushExport();
    return handler(current, req, res);
  });
}

// Resolve getters when a request runs, not while its route is registered.
export function withContext(ctx: WorkspaceContext, handler: ContextHandler) {
  return (req: Request, res: Response) => handler(ctx, req, res);
}
