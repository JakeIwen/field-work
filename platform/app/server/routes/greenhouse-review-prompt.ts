import type { Request, Response } from "express";
import type { WorkspaceContext } from "../server.js";
import { greenhouseReviewPrompt } from "../opening-pull/review-prompt.js";

export function getGreenhouseReviewPrompt(
  { store }: WorkspaceContext,
  _req: Request,
  res: Response,
) {
  res.set("Cache-Control", "no-store");
  res.json(greenhouseReviewPrompt(store));
}
