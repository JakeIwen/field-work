import { tunables } from "../../shared/tunables.js";
import { load } from "cheerio";
import { HttpError } from "../storage.js";
import { GmailError, googleResponseError } from "./errors.js";
export { GmailError, GmailReconnectError } from "./errors.js";

export const gmailReadScope = "https://www.googleapis.com/auth/gmail.readonly";
export const gmailSettingsScope =
  "https://www.googleapis.com/auth/gmail.settings.basic";
export const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";
export const gmailAuthorizationScopes = [
  gmailReadScope,
  gmailSettingsScope,
  gmailSendScope,
];
export type GmailMessage = {
  id: string;
  threadId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  text: string;
  authenticated: boolean;
  listUnsubscribe?: boolean;
  automated?: boolean;
};
export type GmailPage = { ids: string[]; nextPageToken?: string };
export type GmailReader = {
  list(query: string, pageToken?: string): Promise<GmailPage>;
  message(id: string): Promise<GmailMessage | null>;
  thread?(id: string): Promise<GmailMessage[]>;
};
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GmailError("Gmail returned an unexpected response. Try again.");
  return value as Record<string, unknown>;
}
export async function googleJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = tunables["gmail.requestTimeoutS"].default * 1000,
  cooldownMs = tunables["gmail.errorCooldownMin"].default * 60_000,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new GmailError(
      "Could not reach Google. Check your connection and try again.",
    );
  }
  if (!response.ok) throw await googleResponseError(response, cooldownMs);
  try {
    return jsonObject(await response.json());
  } catch {
    throw new GmailError("Google returned an unreadable response. Try again.");
  }
}

function messageText(
  part: Record<string, unknown>,
  limit: number,
  depth = 0,
): string {
  if (depth > 12 || part.filename) return "";
  const children = Array.isArray(part.parts) ? part.parts.map(jsonObject) : [];
  // Prefer the plain alternative to avoid duplicated bodies and quoted HTML.
  const plain = children.find(
    (p) => p.mimeType === "text/plain" && !p.filename,
  );
  if (plain) return messageText(plain, limit, depth + 1);
  if (children.length)
    return children
      .map((p) => messageText(p, limit, depth + 1))
      .join("\n")
      .slice(0, limit);
  if (
    part.filename ||
    !["text/plain", "text/html"].includes(String(part.mimeType))
  )
    return "";
  const body = part.body ? jsonObject(part.body) : undefined;
  if (!body || typeof body.data !== "string") return "";
  const raw = Buffer.from(body.data, "base64url")
    .toString("utf8")
    .slice(0, 100000);
  if (part.mimeType === "text/plain") return raw.slice(0, limit);
  const $ = load(raw);
  $("script,style,blockquote,.gmail_quote").remove();
  $("br").replaceWith("\n");
  $("p,div,tr,li").append("\n");
  return $.text().slice(0, limit);
}
export function parseGmailMessage(
  raw: unknown,
  limit: number = tunables["gmail.textLimitChars"].default,
): GmailMessage | null {
  const value = jsonObject(raw);
  if (
    !/^[a-f\d]+$/i.test(String(value.id)) ||
    !/^[a-f\d]+$/i.test(String(value.threadId))
  )
    throw new GmailError("Gmail returned an invalid message identity.");
  const labels = value.labelIds ?? [];
  if (!Array.isArray(labels))
    throw new GmailError("Gmail returned invalid message labels.");
  if (
    labels.some((l) => ["SENT", "DRAFT", "TRASH", "SPAM"].includes(String(l)))
  )
    return null;
  const payload = jsonObject(value.payload);
  if (!Array.isArray(payload.headers))
    throw new GmailError("Gmail returned incomplete message headers.");
  const headers = payload.headers.map(jsonObject);
  const header = (name: string) =>
    headers
      .filter((h) => String(h.name).toLowerCase() === name)
      .map((h) => String(h.value ?? ""))
      .join("\n");
  const date = new Date(Number(value.internalDate));
  if (!Number.isFinite(date.valueOf()))
    throw new GmailError("Gmail returned an invalid message date.");
  const auth = headers.find(
    (h) => String(h.name).toLowerCase() === "authentication-results",
  )?.value;
  return {
    id: String(value.id),
    threadId: String(value.threadId),
    sender: header("from").slice(0, 500),
    subject: header("subject").slice(0, 1000),
    receivedAt: date.toISOString(),
    text: messageText(payload, limit),
    listUnsubscribe: Boolean(header("list-unsubscribe")),
    automated: /^(auto-generated|auto-replied)$/i.test(
      header("auto-submitted").trim(),
    ),
    authenticated:
      typeof auth === "string" &&
      /^mx\.google\.com;[\s\S]*?\bdmarc=pass\b/i.test(auth.trim()),
  };
}
export function gmailReader(
  token: () => Promise<string>,
  options?: {
    timeoutMs: () => number;
    cooldownMs: () => number;
    pageSize: () => number;
    textLimit: () => number;
  },
): GmailReader {
  const get = async (resource: string) =>
    googleJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/${resource}`,
      {
        headers: { Authorization: `Bearer ${await token()}` },
      },
      options?.timeoutMs(),
      options?.cooldownMs(),
    );
  return {
    async list(query, pageToken) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(
          Math.min(
            100,
            options?.pageSize() ?? tunables["gmail.pageSize"].default,
          ),
        ),
        includeSpamTrash: "false",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const result = await get(`messages?${params}`);
      if (result.messages !== undefined && !Array.isArray(result.messages))
        throw new GmailError("Gmail returned an invalid message list.");
      if (
        result.nextPageToken !== undefined &&
        (typeof result.nextPageToken !== "string" || !result.nextPageToken)
      )
        throw new GmailError("Gmail returned an invalid page cursor.");
      const ids = (result.messages ?? []).map((m: unknown) => {
        const id = jsonObject(m).id;
        if (typeof id !== "string" || !/^[a-f\d]+$/i.test(id))
          throw new GmailError("Gmail returned an invalid message identity.");
        return id;
      });
      return { ids, nextPageToken: result.nextPageToken as string | undefined };
    },
    async thread(id) {
      try {
        const result = await get(
          `threads/${encodeURIComponent(id)}?format=full`,
        );
        if (!Array.isArray(result.messages))
          throw new GmailError("Gmail returned an invalid conversation.");
        const messages = result.messages
          .map((message: unknown) =>
            parseGmailMessage(message, options?.textLimit()),
          )
          .filter((message): message is GmailMessage => message !== null);
        if (messages.some((message) => message.threadId !== id))
          throw new GmailError("Gmail returned a different conversation.");
        return messages;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return [];
        throw error;
      }
    },
    async message(id) {
      try {
        return parseGmailMessage(
          await get(`messages/${encodeURIComponent(id)}?format=full`),
          options?.textLimit(),
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
