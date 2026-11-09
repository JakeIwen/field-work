import { googleResponseError, GmailError } from "./errors.js";
import { googleJson, jsonObject } from "./api.js";

/** Gmail's send outcome is unknown: the request may have reached Google. */
export class GmailSendUncertain extends Error {}

export type GmailSendIdentity = { email: string; name?: string };
export type GmailSender = {
  identity(): Promise<GmailSendIdentity | undefined>;
  send(raw: string): Promise<{ id: string; threadId: string }>;
  raw(id: string): Promise<Buffer>;
};

const gmailUsers = "https://gmail.googleapis.com/gmail/v1/users/me";

export function gmailSender(token: () => Promise<string>): GmailSender {
  const get = async (resource: string) =>
    googleJson(`${gmailUsers}/${resource}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    });
  return {
    async identity() {
      // The primary send-as entry carries the display name Gmail itself would use.
      const result = await get("settings/sendAs");
      const entries = Array.isArray(result.sendAs)
        ? result.sendAs.map(jsonObject)
        : [];
      const entry =
        entries.find((e) => e.isDefault === true) ??
        entries.find((e) => e.isPrimary === true);
      if (!entry || typeof entry.sendAsEmail !== "string") return undefined;
      return {
        email: entry.sendAsEmail,
        name:
          typeof entry.displayName === "string" && entry.displayName.trim()
            ? entry.displayName.trim().slice(0, 200)
            : undefined,
      };
    },
    async send(raw) {
      const authorization = `Bearer ${await token()}`;
      let response: Response;
      try {
        response = await fetch(`${gmailUsers}/messages/send`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            raw: Buffer.from(raw, "utf8").toString("base64url"),
          }),
        });
      } catch {
        throw new GmailSendUncertain(
          "Gmail did not answer the send request. Check your Sent folder before trying again.",
        );
      }
      // A server error may come after Gmail accepted the message; only a 4xx is a clear refusal.
      if (response.status >= 500)
        throw new GmailSendUncertain(
          `Gmail answered the send with an error (HTTP ${response.status}) and may still have sent it. Check your Sent folder before trying again.`,
        );
      if (!response.ok) throw await googleResponseError(response);
      let result: Record<string, unknown>;
      try {
        result = jsonObject(await response.json());
      } catch {
        throw new GmailSendUncertain(
          "Gmail accepted the request but returned an unreadable response. Check your Sent folder before trying again.",
        );
      }
      if (
        typeof result.id !== "string" ||
        !/^[a-f\d]+$/i.test(result.id) ||
        typeof result.threadId !== "string" ||
        !/^[a-f\d]+$/i.test(result.threadId)
      )
        throw new GmailSendUncertain(
          "Gmail did not identify the sent message. Check your Sent folder before trying again.",
        );
      return { id: result.id, threadId: result.threadId };
    },
    async raw(id) {
      const result = await get(`messages/${encodeURIComponent(id)}?format=raw`);
      if (typeof result.raw !== "string" || !result.raw)
        throw new GmailError(
          "Gmail returned the sent message without its content.",
        );
      return Buffer.from(result.raw, "base64url");
    },
  };
}
