type DiagnosticLevel = "info" | "warn" | "error";
type DiagnosticFields = Record<string, unknown>;
export type DiagnosticRole = "cloud-backend" | "mac-companion";
let role: DiagnosticRole = "cloud-backend";

export function setDiagnosticRole(value: DiagnosticRole) {
  role = value;
}

function safeText(value: string) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/g, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]");
}

/** Do not inspect arbitrary error properties: transports may attach headers or bodies. */
function errorChain(
  error: unknown,
  messages: boolean,
  seen = new Set<unknown>(),
): unknown {
  if (seen.has(error)) return "[circular cause]";
  if (!error || typeof error !== "object")
    return messages ? safeText(String(error)) : "UNKNOWN";
  seen.add(error);
  const value = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  return {
    name: typeof value.name === "string" ? safeText(value.name) : "Error",
    ...(messages && typeof value.message === "string"
      ? { message: safeText(value.message) }
      : {}),
    ...(typeof value.code === "string"
      ? { code: value.code.replace(/[^A-Z0-9_]/gi, "") }
      : {}),
    ...(value.cause !== undefined
      ? { cause: errorChain(value.cause, messages, seen) }
      : {}),
    ...(Array.isArray(value.errors)
      ? {
          errors: value.errors.map((cause) =>
            errorChain(cause, messages, seen),
          ),
        }
      : {}),
  };
}

export function diagnosticLog(
  level: DiagnosticLevel,
  component: string,
  message: string,
  fields: DiagnosticFields = {},
  error?: unknown,
) {
  const values = {
    ...fields,
    ...(error !== undefined ? { error: errorChain(error, true) } : {}),
  };
  const suffix = Object.entries(values)
    .map(([key, value]) => {
      const text = /token|password|credential|authorization|cookie|body/i.test(
        key,
      )
        ? "[redacted]"
        : typeof value === "string"
          ? safeText(value)
          : value;
      return `${key}=${JSON.stringify(text)}`;
    })
    .join(" ");
  const line = `${new Date().toISOString()} ${level} role=${role} pid=${process.pid} component=${component} ${JSON.stringify(safeText(message))}${suffix ? ` ${suffix}` : ""}`;
  if (level === "info") console.log(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

type Failure = { count: number; loggedAt: number; fields: DiagnosticFields };

/** Summaries are emitted by traffic, not a timer that outlives the transport. */
export function createProxyDiagnostics(clock = Date.now) {
  const failures = new Map<string, Map<string, Failure>>();
  return {
    failed(
      method: string,
      path: string,
      error: NodeJS.ErrnoException,
      retrying: boolean,
      message: string,
    ) {
      const route = `${method} ${path.split(/[?#]/)[0]}`;
      const code = error.code ?? "UNKNOWN";
      let codes = failures.get(route);
      if (!codes) failures.set(route, (codes = new Map()));
      const previous = codes.get(code);
      const fields = { route, code, retrying, cause: errorChain(error, false) };
      if (!previous) {
        codes.set(code, { count: 1, loggedAt: clock(), fields });
        diagnosticLog("warn", "companion-proxy", message, {
          ...fields,
          count: 1,
        });
      } else {
        previous.count++;
        previous.fields = fields;
        if (clock() - previous.loggedAt < 60_000) return;
        previous.loggedAt = clock();
        diagnosticLog("warn", "companion-proxy", "Proxy failures continue", {
          ...fields,
          count: previous.count,
        });
      }
    },
    recovered(method: string, path: string) {
      const route = `${method} ${path.split(/[?#]/)[0]}`;
      const codes = failures.get(route);
      if (!codes) return;
      for (const failure of codes.values())
        diagnosticLog("info", "companion-proxy", "Proxy connection recovered", {
          ...failure.fields,
          count: failure.count,
        });
      failures.delete(route);
    },
  };
}
