import { companionPreview } from "./companion-preview.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { CompanionConfig } from "./companion-config.js";
import { createCompanionTunnel } from "./companion-tunnel.js";
import {
  proxyCompanionBrowser,
  type CompanionBrowserPorts,
} from "./companion-browser.js";
import { companionInternalRoutes } from "../shared/cloud-connection.js";
import {
  companionRequestHeaders,
  proxyCompanionRequest,
} from "./companion-http.js";

interface CompanionOptions {
  root: string;
  dataDir: string;
  port: number;
  shutdown: () => void;
  config: CompanionConfig;
  renderHandler?: RequestHandler;
  spawn?: NonNullable<Parameters<typeof createCompanionTunnel>[1]>["spawn"];
  browserPorts?: CompanionBrowserPorts;
}

function equalSecret(actual: unknown, expected: string) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function guardLoopback(
  port: number,
  renderForwardPort: number,
  req: Request,
  res: Response,
) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const forwardedRender =
    req.headers.host === `127.0.0.1:${renderForwardPort}` &&
    (req.path === companionInternalRoutes.render ||
      req.path === companionInternalRoutes.browserCleanMcp ||
      req.path === companionInternalRoutes.browserLive ||
      req.path.startsWith(companionInternalRoutes.browserLive + "/")) &&
    !req.headers.origin;
  if (!hosts.has(req.headers.host ?? "") && !forwardedRender) {
    res
      .status(403)
      .json({ error: "Host is not the configured loopback address" });
    return false;
  }
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  if (req.headers.origin && !origins.has(req.headers.origin)) {
    res.status(403).json({ error: "Cross-origin requests are forbidden" });
    return false;
  }
  const entryNavigation =
    req.method === "GET" &&
    (req.path === "/" || req.path === "/api/gmail/callback") &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document";
  if (req.headers["sec-fetch-site"] === "cross-site" && !entryNavigation) {
    res.status(403).json({ error: "Cross-site requests are forbidden" });
    return false;
  }
  return true;
}

export function companionProxyHeaders(
  incoming: Request["headers"],
  config: CompanionConfig,
) {
  return companionRequestHeaders(incoming, {
    host: new URL(config.cloudOrigin).host,
    ...(incoming.origin ? { origin: config.cloudOrigin } : {}),
    machineToken: config.machineToken,
  });
}

function proxyRequest(config: CompanionConfig, req: Request, res: Response) {
  proxyCompanionRequest(
    req,
    res,
    {
      host: "127.0.0.1",
      port: config.localForwardPort,
      method: req.method,
      path: req.originalUrl,
      headers: companionProxyHeaders(req.headers, config),
    },
    "Fieldwork cloud connection unavailable",
    { retryReads: true },
  );
}

export function createCompanion(options: CompanionOptions) {
  if (!path.isAbsolute(options.root) || !path.isAbsolute(options.dataDir))
    throw new Error("Companion paths must be absolute");
  if (
    !Number.isInteger(options.port) ||
    options.port < 1024 ||
    options.port > 65535
  )
    throw new Error("Companion port is invalid");
  const app: Express = express();
  const csrfToken = randomBytes(32).toString("hex");
  const tunnel = createCompanionTunnel(options.config, {
    spawn: options.spawn,
  });

  app.use((req, res, next) => {
    if (guardLoopback(options.port, options.config.remoteForwardPort, req, res))
      next();
  });
  app.use("/api/companion", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/api/companion/health", (_req, res) =>
    res.json({ status: "ok", pid: process.pid, connected: tunnel.connected() }),
  );
  app.get("/api/companion/session", (_req, res) => res.json({ csrfToken }));
  app.post("/api/companion/stop", (req, res) => {
    if (!equalSecret(req.headers["x-csrf-token"], csrfToken))
      return res.status(403).json({ error: "Missing or invalid CSRF token" });
    res.status(202).json({ status: "stopping" });
    options.shutdown();
  });
  app.all(companionInternalRoutes.render, (req, res, next) => {
    if (
      !equalSecret(
        req.headers["x-fieldwork-machine-token"],
        options.config.machineToken,
      )
    )
      return res.status(401).json({ error: "Machine authentication required" });
    if (!options.renderHandler)
      return res.status(503).json({ error: "Rendering is unavailable" });
    return options.renderHandler(req, res, next);
  });
  const browserAuthentication: RequestHandler = (req, res, next) => {
    if (req.headers.origin)
      return res
        .status(403)
        .json({ error: "Browser capability origin rejected" });
    if (
      !equalSecret(
        req.headers["x-fieldwork-machine-token"],
        options.config.machineToken,
      )
    )
      return res.status(401).json({ error: "Machine authentication required" });
    next();
  };
  app.all(
    companionInternalRoutes.browserCleanMcp,
    browserAuthentication,
    (req, res) =>
      proxyCompanionBrowser("clean", req, res, options.browserPorts),
  );
  app.use(
    companionInternalRoutes.browserLive,
    browserAuthentication,
    (req, res) => proxyCompanionBrowser("live", req, res, options.browserPorts),
  );
  app.use(companionPreview(options.dataDir));
  app.use((req, res) => proxyRequest(options.config, req, res));
  tunnel.start();
  return {
    app,
    connected: tunnel.connected,
    close: () => tunnel.close(),
  };
}
