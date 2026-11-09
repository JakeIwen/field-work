

let csrf = "";
let csrfRefresh: Promise<string> | undefined;
export function setCsrf(value: string) {
  csrf = value;
}
async function refreshCsrf() {
  csrfRefresh ??= api<{ csrfToken: string }>("/api/session").then(session => {
    if (!session.csrfToken || typeof session.csrfToken !== "string") throw new Error("The backend did not provide a session token.");
    return csrf = session.csrfToken;
  }).finally(() => { csrfRefresh = undefined; });
  return csrfRefresh;
}
type ApiOptions = {
  headers?: HeadersInit;
  responseType?: "json" | "response";
  signal?: AbortSignal;
};

export function api(
  path: string,
  body: unknown | undefined,
  method: string | undefined,
  options: ApiOptions & { responseType: "response" },
): Promise<Response>;
export function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  options?: ApiOptions,
): Promise<T>;
export async function api(
  path: string,
  body?: unknown,
  method?: string,
  options?: ApiOptions,
): Promise<unknown> {
  const verb = method || (body === undefined ? "GET" : "POST");
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(verb.toUpperCase());
  if (mutation && !csrf) await refreshCsrf();
  const request = () => {
    let headers = options?.headers;
    if (mutation) {
      const authenticated = new Headers(headers);
      authenticated.set("X-CSRF-Token", csrf);
      if (body !== undefined && !authenticated.has("Content-Type")) authenticated.set("Content-Type", "application/json");
      headers = authenticated;
    }
    return fetch(path, {
      method: verb, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  };
  const sentToken = csrf;
  let response = await request();
  if (mutation && response.status === 403) {
    const rejection = await response.clone().json().catch(() => ({}));
    // This guard rejects before any handler runs. Other errors must never replay writes.
    if (rejection.code === "CSRF_TOKEN_INVALID" || rejection.error === "Missing or invalid CSRF token") {
      if (!csrf || csrf === sentToken) await refreshCsrf();
      response = await request();
    }
  }
  // Raw responses preserve call sites' custom status and parse handling.
  if (options?.responseType === "response") return response;
  let value = await successJson(response);
  // Repeat a read once; a write may already have been applied.
  if (value === cutOff && !mutation) value = await successJson(await request());
  if (value === cutOff)
    throw new Error(mutation
      ? "The server's reply was cut off. Check whether the change was saved before trying again."
      : "The server's reply was cut off before it finished. Try again.");
  return value;
}
// Firefox hands a body cut off mid-transfer (a restart or dropped tunnel during
// a large /api/state) to the page as complete, so it fails as invalid JSON.
const cutOff = Symbol("cut off");
async function successJson(response: Response) {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error || error.message || `Request failed (${response.status})`,
    );
  }
  return response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return cutOff;
    throw error;
  });
}
