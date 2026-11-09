import { createProxyDiagnostics } from "./diagnostic-log.js";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import http from "node:http";
import type { Request, Response } from "express";

const proxyDiagnostics = createProxyDiagnostics();

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionHeaders(value: string | string[] | undefined) {
  return new Set(
    (Array.isArray(value) ? value.join(",") : (value ?? ""))
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function excludedHeader(name: string, nominated: Set<string>) {
  return hopByHopHeaders.has(name) || nominated.has(name);
}

export function companionRequestHeaders(
  incoming: IncomingHttpHeaders,
  options: { host: string; origin?: string; machineToken?: string },
) {
  const headers: OutgoingHttpHeaders = { host: options.host };
  const nominated = connectionHeaders(incoming.connection);
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      excludedHeader(lower, nominated) ||
      lower === "host" ||
      lower === "origin" ||
      lower === "authorization" ||
      lower === "x-fieldwork-machine-token" ||
      lower.startsWith("cf-access-")
    )
      continue;
    headers[name] = value;
  }
  if (options.origin) headers.origin = options.origin;
  if (options.machineToken)
    headers["x-fieldwork-machine-token"] = options.machineToken;
  return headers;
}

export function companionResponseHeaders(incoming: IncomingHttpHeaders) {
  const headers: OutgoingHttpHeaders = {};
  const nominated = connectionHeaders(incoming.connection);
  for (const [name, value] of Object.entries(incoming))
    if (value !== undefined && !excludedHeader(name.toLowerCase(), nominated))
      headers[name] = value;
  return headers;
}

function streamResponse(response: http.IncomingMessage, res: Response) {
  if (res.destroyed) return response.destroy();
  res.status(response.statusCode ?? 502);
  for (const [name, value] of Object.entries(
    companionResponseHeaders(response.headers),
  ))
    if (value !== undefined) res.setHeader(name, value);
  response.once("aborted", () => res.destroy());
  response.once("error", () => res.destroy());
  response.pipe(res);
}

type ProxyRecovery = {
  retryReads?: boolean;
  readTimeoutMs?: number;
  retryDelayMs?: number;
};

function headerDeadline(request: http.ClientRequest, timeoutMs: number) {
  return setTimeout(
    () =>
      request.destroy(
        Object.assign(new Error("Cloud response headers timed out"), {
          code: "ETIMEDOUT",
        }),
      ),
    timeoutMs,
  );
}

/** Only bodyless cloud reads can be repeated after losing a transport acknowledgement. */
export function proxyCompanionRequest(
  req: Request,
  res: Response,
  options: http.RequestOptions,
  unavailableMessage: string,
  recovery: ProxyRecovery = {},
) {
  const safeRead =
    recovery.retryReads &&
    ["GET", "HEAD"].includes(req.method) &&
    !req.headers["transfer-encoding"] &&
    (!req.headers["content-length"] || req.headers["content-length"] === "0");
  let upstream: http.ClientRequest | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let receivedHeaders = false;
  const cancel = () => {
    clearTimeout(deadline);
    clearTimeout(retry);
    upstream?.destroy();
  };
  const send = () => {
    if (res.destroyed || req.aborted) return;
    attempts++;
    const current = http.request(options, (response) => {
      clearTimeout(deadline);
      receivedHeaders = true;
      proxyDiagnostics.recovered(req.method, req.path);
      streamResponse(response, res);
    });
    upstream = current;
    if (safeRead)
      deadline = headerDeadline(current, recovery.readTimeoutMs ?? 15_000);
    current.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      if (res.destroyed || req.aborted) return;
      const code = error.code ?? "UNKNOWN";
      const retrying =
        safeRead &&
        !receivedHeaders &&
        attempts < 2 &&
        ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(code);
      // Keep transport causes, but never log credentials, query strings or bodies.
      proxyDiagnostics.failed(
        req.method,
        req.path,
        error,
        !!retrying,
        unavailableMessage,
      );
      if (retrying) {
        retry = setTimeout(send, recovery.retryDelayMs ?? 1000);
      } else if (!res.headersSent) {
        res.status(503).json({ error: unavailableMessage });
      } else res.destroy();
    });
    if (attempts === 1) req.pipe(current);
    else current.end();
  };
  res.once("close", cancel);
  req.once("aborted", cancel);
  send();
}
