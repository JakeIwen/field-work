import type { Express, Request, Response } from "express";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";
import { withContext } from "./context.js";
import {
  applicationRecipients,
  emptyFollowUp,
  followUpApplication,
  followUpSummary,
  followUpTextFields,
  readFollowUp,
  restoreFollowUpDraft,
  saveFollowUpEdit,
} from "../follow-up-email.js";
import {
  followUpReviseRequest,
  followUpTaskServices,
  reviseFollowUpDraft,
  startFollowUpDraft,
} from "../follow-up-email-task.js";
import {
  followUpSendRequest,
  resolveUncertainSend,
  sendFollowUp,
  type FollowUpSendServices,
} from "../follow-up-email-send.js";
import type {
  ApplicationFollowUp,
  FollowUpSendCapability,
  FollowUpView,
  SentFollowUpEmail,
} from "../../shared/follow-up-email.js";

const applicationId = (req: Request) => String(req.params.id);

function capability(ctx: WorkspaceContext): FollowUpSendCapability {
  const state = ctx.gmail.auth.state();
  return {
    connected: state.connected,
    sendGranted: state.connected && state.sendGranted,
    account: state.account,
  };
}

function view(
  ctx: WorkspaceContext,
  record: ApplicationFollowUp,
  sent?: SentFollowUpEmail,
): FollowUpView {
  const application = followUpApplication(ctx.store, record.applicationId);
  return {
    followUp: followUpSummary(
      ctx.store,
      record,
      applicationRecipients(ctx.store, application),
    ),
    history: record.history,
    capability: capability(ctx),
    ...(sent ? { sent } : {}),
  };
}

const changed = (ctx: WorkspaceContext) => {
  ctx.store.autoExport();
  ctx.publish("state");
};

export function followUpSendServices(
  ctx: WorkspaceContext,
): FollowUpSendServices {
  return {
    store: ctx.store,
    capability: () => capability(ctx),
    sender: ctx.gmailSender,
    active: ctx.followUpSends,
    changed: () => changed(ctx),
  };
}

type FollowUpChange = (
  ctx: WorkspaceContext,
  req: Request,
) => ApplicationFollowUp;

function restoreChange(ctx: WorkspaceContext, req: Request) {
  if (typeof req.body?.draftId !== "string")
    throw new HttpError(400, "Choose an earlier draft to restore.");
  return restoreFollowUpDraft(
    ctx.store,
    applicationId(req),
    ctx.version(req.body.expectedVersion),
    req.body.draftId,
  );
}

/** Each change answers with the updated view, then exports and publishes once. */
const changes: ["post" | "put", string, FollowUpChange][] = [
  [
    "post",
    "/draft",
    (c, req) => startFollowUpDraft(followUpTaskServices(c), applicationId(req)),
  ],
  [
    "put",
    "",
    (c, req) =>
      saveFollowUpEdit(
        c.store,
        applicationId(req),
        c.version(req.body?.expectedVersion),
        followUpTextFields(req.body),
      ),
  ],
  [
    "post",
    "/revise",
    (c, req) =>
      reviseFollowUpDraft(
        followUpTaskServices(c),
        applicationId(req),
        followUpReviseRequest(req.body),
      ),
  ],
  ["post", "/restore", restoreChange],
  [
    "post",
    "/sending/resolve",
    (c, req) =>
      resolveUncertainSend(
        c.store,
        applicationId(req),
        c.version(req.body?.expectedVersion),
        req.body?.outcome,
      ),
  ],
];

async function send(ctx: WorkspaceContext, req: Request, res: Response) {
  const result = await sendFollowUp(
    followUpSendServices(ctx),
    applicationId(req),
    followUpSendRequest(req.body),
  );
  res.json(view(ctx, result.record, result.sent));
}

export function register(app: Express, ctx: WorkspaceContext) {
  const base = "/api/applications/:id/follow-up";
  app.get(
    base,
    withContext(ctx, (c, req, res) => {
      const application = followUpApplication(c.store, applicationId(req));
      res.json(
        view(
          c,
          readFollowUp(c.store, application.id) ?? emptyFollowUp(application),
        ),
      );
    }),
  );
  for (const [method, path, change] of changes)
    app[method](
      `${base}${path}`,
      withContext(ctx, (c, req, res) => {
        const record = change(c, req);
        changed(c);
        res.json(view(c, record));
      }),
    );
  app.post(`${base}/send`, withContext(ctx, send));
}
