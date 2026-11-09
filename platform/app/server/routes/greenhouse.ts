import { greenhouseReviewPromptPath } from "../../shared/greenhouse-review-prompt.js";
import { getGreenhouseReviewPrompt } from "./greenhouse-review-prompt.js";
import { rereviewCandidate } from "../opening-pull/review-memory.js";
import { pullMetricsPath } from "../../shared/greenhouse-pull-metrics.js";
import { pullMetrics } from "../opening-pull/pull-metrics.js";
import { parsePullMetricsQuery } from "../opening-pull/metrics-query.js";
import type { Express, Request, Response } from "express";
import type { WorkspaceContext } from "../server.js";
import { HttpError } from "../storage.js";
import { withContext } from "./context.js";
import {
  validateGreenhouseGuidance,
  validateGreenhousePolicy,
  validateGreenhouseSearchTermPool,
} from "../opening-pull/guidance.js";
import {
  deleteGreenhouseGuidanceHistory,
  greenhouseGuidanceHistory,
  rememberGreenhouseGuidance,
} from "../opening-pull/guidance-history.js";
import { validateExcludedGreenhouseCompanies } from "../opening-pull/company-filter.js";
import {
  validateGreenhousePacing,
  validateGreenhousePacingPenalty,
} from "../greenhouse-pacing.js";
import {
  validateGreenhouseFormCheckNewOpenings,
  validateGreenhouseParallelReviews,
  validateGreenhouseSearchLookahead,
} from "../greenhouse-review-settings.js";

function saveGreenhousePullSettings(
  { store, changed, version, greenhousePull }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed. Use the current values before saving pull settings.",
    );
  const greenhousePacingRate = validateGreenhousePacing(req.body.pacingRate);
  const penalty =
    req.body.pacingPenaltyMs === undefined
      ? {}
      : {
          greenhousePacingPenaltyMs: validateGreenhousePacingPenalty(
            req.body.pacingPenaltyMs,
          ),
        };
  const parallelReviews = validateGreenhouseParallelReviews(
    req.body.parallelReviews,
  );
  const greenhouseSearchLookahead = validateGreenhouseSearchLookahead(
    req.body.searchLookahead,
  );
  const formCheck =
    req.body.formCheckNewOpenings === undefined
      ? {}
      : {
          greenhouseFormCheckNewOpenings:
            validateGreenhouseFormCheckNewOpenings(
              req.body.formCheckNewOpenings,
            ),
        };
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      ...penalty,
      ...formCheck,
      greenhousePacingRate,
      parallelReviews,
      greenhouseSearchLookahead,
      version: old.version + 1,
    }),
  );
  greenhousePull?.wake();
}

function saveGreenhouseParallelReviews(
  { store, changed, version, greenhousePull }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed. Use the current value before saving parallel reviews.",
    );
  const parallelReviews = validateGreenhouseParallelReviews(
    req.body.parallelReviews,
  );
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      parallelReviews,
      version: old.version + 1,
    }),
  );
  greenhousePull?.wake();
}

function saveGreenhousePacing(
  { store, changed, version }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed. Use the current value before saving the page interval.",
    );
  const greenhousePacingRate = validateGreenhousePacing(req.body.pacingRate);
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      greenhousePacingRate,
      version: old.version + 1,
    }),
  );
}

function saveGreenhouseCompanies(
  { store, changed, version }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed. Use the current company filter before saving.",
    );
  const greenhouseExcludedCompanies = validateExcludedGreenhouseCompanies(
    req.body.companies,
  );
  changed(
    res,
    store.put("settings", "main", {
      ...old,
      greenhouseExcludedCompanies,
      version: old.version + 1,
    }),
  );
}

function saveGreenhouseGuidance(
  { store, changed, version }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const old = store.settings();
  if (version(req.body.expectedVersion) !== old.version)
    throw new HttpError(
      409,
      "Settings changed in another tab. Reload before saving pull instructions.",
    );
  const greenhouseGuidance = validateGreenhouseGuidance(req.body.guidance);
  const companies = req.body.excludedCompanies;
  const pool = req.body.searchTermPool;
  const updates = {
    ...(req.body.policy === undefined
      ? {}
      : { greenhousePolicy: validateGreenhousePolicy(req.body.policy) }),
    ...(companies === undefined
      ? {}
      : {
          greenhouseExcludedCompanies:
            validateExcludedGreenhouseCompanies(companies),
        }),
    ...(pool === undefined
      ? {}
      : { greenhouseSearchTermPool: validateGreenhouseSearchTermPool(pool) }),
  };
  const saved = store.transaction(() => {
    const settings = store.put("settings", "main", {
      ...old,
      ...updates,
      greenhouseGuidance,
      version: old.version + 1,
    });
    rememberGreenhouseGuidance(store, greenhouseGuidance.instructions);
    return settings;
  });
  changed(res, saved);
}

function startGreenhousePull(
  { changed, greenhousePull }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  const providers: unknown = req.body.providers;
  if (
    providers !== undefined &&
    (!Array.isArray(providers) ||
      providers.length !== 1 ||
      providers[0] !== "greenhouse")
  )
    throw new HttpError(
      400,
      'Pull listings supports only Greenhouse; omit providers or use ["greenhouse"]',
    );
  changed(
    res,
    greenhousePull!.start(
      req.body.target ?? 10,
      req.body.clientRequestId ?? "",
    ),
  );
}

function controlGreenhousePull(
  { changed, greenhousePull }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  changed(
    res,
    greenhousePull!.action(
      String(req.params.id),
      req.body.action,
      req.body.interruptReviews,
    ),
  );
}

function getGreenhousePullLedger(
  { greenhousePull }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  return res.json(greenhousePull!.ledger(String(req.params.id)));
}

function getGreenhouseMetrics(
  { store }: WorkspaceContext,
  req: Request,
  res: Response,
) {
  return res.json(pullMetrics(store, parsePullMetricsQuery(req.query)));
}

export function register(
  app: Express,
  ctx: WorkspaceContext,
  phase: "start" | "control",
) {
  if (phase === "start") {
    app.get(
      greenhouseReviewPromptPath,
      withContext(ctx, getGreenhouseReviewPrompt),
    );
    app.post(
      "/api/greenhouse/pull-settings",
      withContext(ctx, saveGreenhousePullSettings),
    );
    app.post(
      "/api/greenhouse/excluded-companies",
      withContext(ctx, saveGreenhouseCompanies),
    );
    app.post("/api/greenhouse/pacing", withContext(ctx, saveGreenhousePacing));
    app.post(
      "/api/greenhouse/parallel-reviews",
      withContext(ctx, saveGreenhouseParallelReviews),
    );
    app.post(
      "/api/greenhouse/guidance",
      withContext(ctx, saveGreenhouseGuidance),
    );
    app.get(
      "/api/greenhouse/guidance/history",
      withContext(ctx, ({ store }, _req, res) => {
        res.json(greenhouseGuidanceHistory(store));
      }),
    );
    app.delete(
      "/api/greenhouse/guidance/history/:id",
      withContext(ctx, ({ store, changed }, req, res) => {
        changed(
          res,
          deleteGreenhouseGuidanceHistory(store, String(req.params.id)),
        );
      }),
    );
    app.post("/api/greenhouse/pulls", withContext(ctx, startGreenhousePull));
    return;
  }
  app.post(
    "/api/greenhouse/pulls/:id/candidates/:candidateId/rereview",
    withContext(ctx, ({ store, changed }, req, res) => {
      changed(
        res,
        rereviewCandidate(
          store,
          String(req.params.id),
          String(req.params.candidateId),
        ),
      );
    }),
  );
  app.post(
    "/api/greenhouse/pulls/:id/action",
    withContext(ctx, controlGreenhousePull),
  );
  app.get(pullMetricsPath, withContext(ctx, getGreenhouseMetrics));
  app.get(
    "/api/greenhouse/pulls/:id/ledger",
    withContext(ctx, getGreenhousePullLedger),
  );
}
