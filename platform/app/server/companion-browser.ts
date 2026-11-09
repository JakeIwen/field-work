import type { Request, Response } from "express";
import {
  companionRequestHeaders,
  proxyCompanionRequest,
} from "./companion-http.js";

type BrowserTarget = "clean" | "live";
export type CompanionBrowserPorts = { clean: number; live: number };
export const companionBrowserPorts: CompanionBrowserPorts = Object.freeze({
  clean: 8931,
  live: 61822,
});

export function proxyCompanionBrowser(
  target: BrowserTarget,
  req: Request,
  res: Response,
  ports: CompanionBrowserPorts = companionBrowserPorts,
) {
  const clean = target === "clean";
  const port = clean ? ports.clean : ports.live;
  const hostname = clean ? "localhost" : "127.0.0.1";
  proxyCompanionRequest(
    req,
    res,
    {
      host: hostname,
      port,
      method: req.method,
      path: clean
        ? `/mcp${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`
        : req.url || "/",
      headers: companionRequestHeaders(req.headers, {
        host: `${hostname}:${port}`,
      }),
    },
    "Browser capability unavailable",
  );
}
