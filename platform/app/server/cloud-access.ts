import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface CloudAccessConfig {
  ownerEmail: string;
  teamUrl: string;
  audience: string;
  publicOrigin: string;
  jwksCacheTtlMs?: number;
}

interface CloudAccessDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtClaims {
  aud: string | string[];
  email: string;
  exp: number;
  iss: string;
  nbf?: number;
}

const DEFAULT_JWKS_TTL_MS = 5 * 60_000;
const MAX_JWKS_TTL_MS = 60 * 60_000;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 30_000;
const MAX_KEYS = 32;

function exactHttpsOrigin(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`${label} must be an HTTPS origin`);
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${label} must not include a path, query, or fragment`);
  return url.origin;
}

export function resolveCloudAccessConfig(
  env: NodeJS.ProcessEnv,
): CloudAccessConfig | null {
  const enabled = env.FIELDWORK_CLOUD_ACCESS;
  if (enabled === undefined || enabled === "0" || enabled === "false") {
    const partial = [
      env.FIELDWORK_CLOUD_TEAM_URL,
      env.FIELDWORK_CLOUD_ACCESS_AUD,
      env.FIELDWORK_PUBLIC_ORIGIN,
    ].some(Boolean);
    if (partial)
      throw new Error("Cloud Access settings require FIELDWORK_CLOUD_ACCESS=1");
    return null;
  }
  if (enabled !== "1" && enabled !== "true")
    throw new Error("FIELDWORK_CLOUD_ACCESS must be 1, true, 0, or false");
  const teamUrl = env.FIELDWORK_CLOUD_TEAM_URL;
  const audience = env.FIELDWORK_CLOUD_ACCESS_AUD;
  const publicOrigin = env.FIELDWORK_PUBLIC_ORIGIN;
  if (!teamUrl || !audience || !publicOrigin)
    throw new Error(
      "Cloud Access requires team URL, audience, and public origin",
    );
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(audience))
    throw new Error("Cloud Access audience is invalid");
  const normalizedTeamUrl = exactHttpsOrigin(teamUrl, "Cloud Access team URL");
  if (!new URL(normalizedTeamUrl).hostname.endsWith(".cloudflareaccess.com"))
    throw new Error(
      "Cloud Access team URL must be a cloudflareaccess.com team",
    );
  const ownerEmail = env.FIELDWORK_OWNER_EMAIL?.trim();
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))
    throw new Error("Cloud Access requires a valid FIELDWORK_OWNER_EMAIL");
  return {
    ownerEmail,
    teamUrl: normalizedTeamUrl,
    audience,
    publicOrigin: exactHttpsOrigin(publicOrigin, "Fieldwork public origin"),
  };
}

function decodeJson<T>(part: string): T {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("Malformed JWT");
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed JWT JSON");
  return value as T;
}

function parseJwt(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new Error("Malformed JWT");
  const header = decodeJson<JwtHeader>(parts[0]);
  const claims = decodeJson<JwtClaims>(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid)
    throw new Error("Unsupported JWT header");
  return {
    claims,
    header,
    input: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: Buffer.from(parts[2], "base64url"),
  };
}

function validClaims(
  claims: JwtClaims,
  config: CloudAccessConfig,
  now: number,
) {
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return (
    claims.iss === config.teamUrl &&
    audience.includes(config.audience) &&
    typeof claims.email === "string" &&
    claims.email.trim().toLowerCase() ===
      config.ownerEmail.trim().toLowerCase() &&
    Number.isFinite(claims.exp) &&
    claims.exp > now &&
    (claims.nbf === undefined ||
      (Number.isFinite(claims.nbf) && claims.nbf <= now))
  );
}

function createKeyCache(
  config: CloudAccessConfig,
  fetcher: typeof fetch,
  now: () => number,
) {
  let keys = new Map<string, JsonWebKey>();
  let expiresAt = 0;
  let lastUnknownKeyRefresh = 0;
  let pending: Promise<void> | undefined;
  const ttl = Math.min(
    Math.max(config.jwksCacheTtlMs ?? DEFAULT_JWKS_TTL_MS, 1_000),
    MAX_JWKS_TTL_MS,
  );

  const refresh = () => {
    pending ??= (async () => {
      const response = await fetcher(`${config.teamUrl}/cdn-cgi/access/certs`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Cloud Access key retrieval failed");
      const body = (await response.json()) as { keys?: JsonWebKey[] };
      if (
        !Array.isArray(body.keys) ||
        body.keys.length < 1 ||
        body.keys.length > MAX_KEYS
      )
        throw new Error("Cloud Access returned invalid keys");
      const replacement = new Map<string, JsonWebKey>();
      for (const key of body.keys) {
        if (key.kty !== "RSA" || typeof key.kid !== "string" || !key.kid)
          throw new Error("Cloud Access returned an invalid signing key");
        replacement.set(key.kid, key);
      }
      keys = replacement;
      expiresAt = now() + ttl;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return async (kid: string) => {
    if (now() >= expiresAt) await refresh();
    let key = keys.get(kid);
    if (
      !key &&
      now() - lastUnknownKeyRefresh >= UNKNOWN_KEY_REFRESH_COOLDOWN_MS
    ) {
      lastUnknownKeyRefresh = now();
      await refresh();
      key = keys.get(kid);
    }
    return key;
  };
}

export function createCloudAccessMiddleware(
  config: CloudAccessConfig,
  dependencies: CloudAccessDependencies = {},
): RequestHandler {
  if (
    !config.ownerEmail ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail.trim())
  )
    throw new Error("Cloud Access requires a valid FIELDWORK_OWNER_EMAIL");
  const normalized: CloudAccessConfig = {
    ...config,
    teamUrl: exactHttpsOrigin(config.teamUrl, "Cloud Access team URL"),
    publicOrigin: exactHttpsOrigin(
      config.publicOrigin,
      "Fieldwork public origin",
    ),
  };
  if (!new URL(normalized.teamUrl).hostname.endsWith(".cloudflareaccess.com"))
    throw new Error(
      "Cloud Access team URL must be a cloudflareaccess.com team",
    );
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(normalized.audience))
    throw new Error("Cloud Access audience is invalid");
  const now = dependencies.now ?? (() => Date.now());
  const findKey = createKeyCache(normalized, dependencies.fetch ?? fetch, now);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assertion = req.headers["cf-access-jwt-assertion"];
      if (typeof assertion !== "string") throw new Error("Missing assertion");
      const jwt = parseJwt(assertion);
      const key = await findKey(jwt.header.kid);
      if (!key) throw new Error("Unknown signing key");
      if (
        !verify(
          "RSA-SHA256",
          jwt.input,
          createPublicKey({ key, format: "jwk" }),
          jwt.signature,
        )
      )
        throw new Error("Invalid signature");
      if (!validClaims(jwt.claims, normalized, Math.floor(now() / 1_000)))
        throw new Error("Invalid claims");
      next();
    } catch {
      res.status(401).json({ error: "Cloud Access authentication required" });
    }
  };
}
