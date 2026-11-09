const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type FetchFailureCause = {
  name: string;
  message: string;
  code?: string;
};
export type AutofillFetchAttempt = {
  url: string;
  attempt: number;
  elapsedMs: number;
  status?: number;
  outcome: "succeeded" | "retrying" | "failed" | "cancelled";
  retryDelayMs?: number;
  causes?: FetchFailureCause[];
};

function errorCode(error: Error) {
  return "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function temporary(error: unknown, seen = new Set<unknown>()): boolean {
  if (!(error instanceof Error) || seen.has(error) || seen.size >= 12)
    return false;
  seen.add(error);
  if (error instanceof AggregateError && error.errors.length)
    return error.errors.every((cause) => temporary(cause, new Set(seen)));
  if (error.cause && temporary(error.cause, seen)) return true;
  return (
    transientCodes.has(errorCode(error) ?? "") ||
    error.name === "TimeoutError" ||
    /timed out|timeout|socket hang up/i.test(error.message)
  );
}

/** Node HTTP wraps request timeouts in AbortError and connection failures in AggregateError. */
export function describeAutofillFetchFailure(error: unknown) {
  const causes: FetchFailureCause[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (seen.has(value) || causes.length >= 12) return;
    seen.add(value);
    if (!(value instanceof Error)) {
      causes.push({ name: "Error", message: String(value).slice(0, 400) });
      return;
    }
    causes.push({
      name: value.name,
      message: value.message.slice(0, 400),
      ...(errorCode(value) ? { code: errorCode(value) } : {}),
    });
    if (value.cause !== undefined) visit(value.cause);
    if (value instanceof AggregateError) value.errors.forEach(visit);
  };
  visit(error);
  return {
    causes,
    temporary: temporary(error),
    summary: causes
      .map((cause) => `${cause.code || cause.name}: ${cause.message}`)
      .join("; ")
      .slice(0, 900),
  };
}
