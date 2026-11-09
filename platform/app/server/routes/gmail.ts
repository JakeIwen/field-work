import type { Express } from "express";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";

export function register(app: Express, ctx: WorkspaceContext) {
  app.get("/api/gmail", (_req, res) => res.json(ctx.gmail.state()));
  app.post("/api/gmail/check", (req, res) => {
    if (req.body.manual !== undefined && typeof req.body.manual !== "boolean")
      throw new HttpError(400, "Invalid Gmail check request.");
    res.status(202).json(ctx.gmail.check(req.body.manual === true));
  });
  app.post("/api/gmail/settings", (req, res) =>
    res.json(ctx.gmail.settings(req.body)),
  );
  app.post("/api/gmail/configure", (req, res) => {
    ctx.gmail.assertIdle();
    ctx.gmail.auth.configure(req.body);
    res.json(ctx.gmail.state());
  });
  app.post("/api/gmail/connect", (req, res) => {
    ctx.gmail.assertIdle();
    res.json(ctx.gmail.auth.start(req.body?.returnTo));
  });
  app.get("/api/gmail/callback", async (req, res) => {
    ctx.gmail.assertIdle();
    let returnTo = "#settings";
    try {
      returnTo = await ctx.gmail.auth.finish(
        req.query.state,
        req.query.code,
        req.query.error,
      );
      ctx.gmail.wakeBackground();
    } catch (error) {
      res
        .status(400)
        .type("text")
        .send(
          `${(error as Error).message}\nReturn to Fieldwork Settings to reconnect.`,
        );
      return;
    }
    ctx.publish("state");
    res.redirect(303, `/${returnTo}`);
  });
  app.post("/api/gmail/disconnect", (_req, res) =>
    res.json(ctx.gmail.disconnect()),
  );
  app.post("/api/gmail/replies/:id/review", (req, res) =>
    res.json(ctx.gmail.review(String(req.params.id))),
  );
}
