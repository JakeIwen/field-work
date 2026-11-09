import { tunables } from "../../shared/tunables.js";
import { HttpError } from "../storage.js";

export class GmailError extends HttpError {
  constructor(
    message: string,
    public retryAt?: string,
  ) {
    super(502, message);
  }
}

/** Google no longer accepts the saved authorization; the client offers a Reconnect Gmail button beside the message. */
export class GmailReconnectError extends GmailError {}

function errorFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function googleErrorReasons(response: Response) {
  const payload = errorFields(await response.json().catch(() => undefined));
  const error = errorFields(payload.error);
  const details = Array.isArray(error.details)
    ? error.details.map(errorFields)
    : [];
  const errors = Array.isArray(error.errors)
    ? error.errors.map(errorFields)
    : [];
  const reasons = [
    payload.error,
    error.status,
    ...errors.map((item) => item.reason),
    ...details.map((item) => item.reason),
  ].filter((value): value is string => typeof value === "string");
  // Only structured, bounded identifiers reach the UI. Google's prose may echo private request data.
  const consumer = details
    .map((item) => errorFields(item.metadata).consumer)
    .find(
      (value) =>
        typeof value === "string" && /^projects\/\d{1,30}$/.test(value),
    );
  return {
    reasons,
    project: typeof consumer === "string" ? consumer.split("/")[1] : undefined,
  };
}

function rateLimitError(
  response: Response,
  daily: boolean,
  cooldownMs: number,
) {
  const retry = response.headers.get("retry-after");
  const parsed =
    retry && /^\d+$/.test(retry)
      ? Date.now() + Number(retry) * 1000
      : Date.parse(retry ?? "");
  const minimum = Date.now() + cooldownMs;
  const requested =
    Number.isFinite(parsed) && parsed <= 8640000000000000
      ? parsed
      : Date.now() + 900000;
  const retryAt = new Date(Math.max(minimum, requested)).toISOString();
  return new GmailError(
    daily
      ? "Google reports that the Gmail API daily quota was exceeded. Check the project's Gmail API quota or wait for it to reset."
      : "Google rate-limited the Gmail request. Wait for the cooldown, then try again.",
    retryAt,
  );
}

export async function googleResponseError(
  response: Response,
  cooldownMs = tunables["gmail.errorCooldownMin"].default * 60_000,
): Promise<HttpError> {
  const { reasons, project } = await googleErrorReasons(response);
  const has = (...names: string[]) =>
    names.some((name) => reasons.includes(name));
  if (has("SERVICE_DISABLED", "accessNotConfigured", "API_DISABLED"))
    return new GmailError(
      `Gmail API is not enabled for the OAuth client's Google Cloud project${project ? ` (${project})` : ""}. Enable Gmail API in that project, allow a few minutes for the change to apply, then connect Gmail again.`,
    );
  if (
    has(
      "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      "insufficientPermissions",
      "insufficient_scope",
    )
  )
    return new GmailError(
      "Google did not grant the Gmail read permission required by Fieldwork. Connect Gmail again and approve read-only Gmail access.",
    );
  if (has("domainPolicy", "ORG_RESTRICTION_VIOLATION", "admin_policy_enforced"))
    return new GmailError(
      "Your Google Workspace policy blocks this app's Gmail access. Ask the Workspace administrator to allow Fieldwork, then connect again.",
    );
  if (
    response.status === 429 ||
    has(
      "rateLimitExceeded",
      "userRateLimitExceeded",
      "RATE_LIMIT_EXCEEDED",
      "RESOURCE_EXHAUSTED",
      "dailyLimitExceeded",
      "quotaExceeded",
      "QUOTA_EXCEEDED",
    )
  )
    return rateLimitError(response, has("dailyLimitExceeded"), cooldownMs);
  if (response.status === 401 || has("invalid_grant", "authError"))
    return new GmailReconnectError(
      "Gmail authorization expired or was revoked.",
    );
  if (has("invalid_client", "unauthorized_client", "deleted_client"))
    return new GmailError(
      "Google rejected the OAuth client credentials. Check that the uploaded Desktop OAuth client and its secret are still enabled, then configure Gmail again.",
    );
  if (has("access_denied"))
    return new GmailError(
      "Google denied this account access to Fieldwork. Check the project's OAuth test users and account access settings, then connect again.",
    );
  if (response.status === 403)
    return new GmailError(
      "Google denied Gmail access (HTTP 403). Check that Gmail API is enabled for the OAuth client's project and that the account is allowed by its OAuth access settings. This response did not identify a rate limit.",
    );
  if (response.status === 404)
    return new HttpError(404, "Gmail message is no longer available.");
  if (response.status >= 500)
    return new GmailError(
      `Google's Gmail service is temporarily unavailable (HTTP ${response.status}). Try again later.`,
    );
  return new GmailError(
    `Google could not complete the request (HTTP ${response.status}). Reconnect Gmail if this continues.`,
  );
}
