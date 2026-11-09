import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { atomicWrite, HttpError } from "../storage.js";
import {
  gmailAuthorizationScopes,
  gmailSendScope,
  gmailSettingsScope,
  googleJson,
  jsonObject,
  GmailError,
} from "./api.js";

type Client = { clientId: string; clientSecret: string };
type Tokens = { refreshToken: string; account: string; scopes?: string[] };
type Pending = {
  state: string;
  verifier: string;
  expires: number;
  returnTo?: string;
};
/** In-app places an authorization may return to; anything else lands on Settings. */
const returnRoute =
  /^#(?:settings|replies|applications\/[A-Za-z0-9%._-]{1,200})$/;
export const gmailReturnRoute = (value: unknown) =>
  typeof value === "string" && returnRoute.test(value) ? value : "#settings";

export class GmailAuth {
  private clientFile: string;
  private tokenFile: string;
  private pending?: Pending;
  private access?: { token: string; expires: number };
  private refreshing?: Promise<string>;
  connecting = false;
  error?: string;
  readonly redirectUri: string;

  constructor(dataDir: string, port: number) {
    this.clientFile = path.join(dataDir, "gmail", "client.json");
    this.tokenFile = path.join(dataDir, "gmail", "tokens.json");
    this.redirectUri = `http://127.0.0.1:${port}/api/gmail/callback`;
  }
  private read<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      throw new HttpError(
        500,
        "The saved Gmail connection is unreadable. Configure Gmail again.",
      );
    }
  }
  state() {
    try {
      const tokens = this.read<Tokens>(this.tokenFile);
      return {
        configured: existsSync(this.clientFile),
        connected: !!tokens?.refreshToken,
        account: tokens?.account,
        filterSettingsGranted:
          tokens?.scopes?.includes(gmailSettingsScope) ?? false,
        sendGranted: tokens?.scopes?.includes(gmailSendScope) ?? false,
        error: this.error,
      };
    } catch (error) {
      return {
        configured: false,
        connected: false,
        filterSettingsGranted: false,
        sendGranted: false,
        error: (error as Error).message,
      };
    }
  }
  configure(raw: unknown) {
    this.assertIdle();
    if (this.state().connected)
      throw new HttpError(
        409,
        "Disconnect Gmail before replacing its OAuth client.",
      );
    const root = jsonObject(raw);
    if (!root.installed)
      throw new HttpError(
        400,
        "Choose the Google OAuth JSON downloaded for a Desktop app client.",
      );
    const client = jsonObject(root.installed);
    if (
      typeof client.client_id !== "string" ||
      !/^[\w-]+\.apps\.googleusercontent\.com$/.test(client.client_id) ||
      typeof client.client_secret !== "string" ||
      client.client_secret.length < 5 ||
      client.client_secret.length > 1000
    )
      throw new HttpError(
        400,
        "The downloaded OAuth client is missing its client ID or secret.",
      );
    atomicWrite(
      this.clientFile,
      JSON.stringify({
        clientId: client.client_id,
        clientSecret: client.client_secret,
      } satisfies Client),
    );
    this.pending = undefined;
    this.error = undefined;
  }
  start(returnTo?: unknown) {
    this.assertIdle();
    const client = this.read<Client>(this.clientFile);
    if (!client)
      throw new HttpError(
        400,
        "Upload your Google Desktop OAuth client JSON first.",
      );
    const pending = {
      state: randomBytes(32).toString("base64url"),
      verifier: randomBytes(48).toString("base64url"),
      expires: Date.now() + 600000,
      returnTo: gmailReturnRoute(returnTo),
    };
    this.pending = pending;
    this.error = undefined;
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: gmailAuthorizationScopes.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      state: pending.state,
      code_challenge: createHash("sha256")
        .update(pending.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  }
  async finish(state: unknown, code: unknown, denied: unknown) {
    this.assertIdle();
    const pending = this.pending;
    if (
      !pending ||
      pending.expires < Date.now() ||
      typeof state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      state.length !== pending.state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))
    )
      throw new HttpError(
        400,
        "This Gmail authorization expired or does not match. Start Connect Gmail again.",
      );
    this.pending = undefined;
    this.connecting = true;
    try {
      if (denied)
        throw new HttpError(
          400,
          "Google authorization was cancelled. Connect Gmail when you are ready.",
        );
      if (typeof code !== "string" || !code || code.length > 4000)
        throw new HttpError(
          400,
          "Google did not return an authorization code.",
        );
      const tokens = await this.exchange({
        code,
        code_verifier: pending.verifier,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      });
      if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token)
        throw new GmailError(
          "Google did not provide offline access. Connect Gmail again and approve Gmail access.",
        );
      const scopes = this.grantedScopes(tokens.scope);
      const access = this.accessToken(tokens);
      const profile = await googleJson(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: { Authorization: `Bearer ${access.token}` } },
      );
      if (
        typeof profile.emailAddress !== "string" ||
        !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)
      )
        throw new GmailError("Google did not identify the connected mailbox.");
      atomicWrite(
        this.tokenFile,
        JSON.stringify({
          refreshToken: tokens.refresh_token,
          account: profile.emailAddress.toLowerCase(),
          scopes,
        } satisfies Tokens),
      );
      this.access = access;
      this.error = undefined;
      return pending.returnTo ?? "#settings";
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    } finally {
      this.connecting = false;
    }
  }
  private grantedScopes(value: unknown): string[] {
    const scopes = typeof value === "string" ? value.split(" ") : [];
    if (!gmailAuthorizationScopes.every((scope) => scopes.includes(scope)))
      throw new GmailError(
        "Gmail read, filter settings and send access were not all granted. Reconnect Gmail and approve all three permissions.",
      );
    return scopes;
  }
  private exchange(params: Record<string, string>) {
    const client = this.read<Client>(this.clientFile);
    if (!client) throw new HttpError(400, "Configure Gmail first.");
    return googleJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    });
  }
  private accessToken(tokens: Record<string, unknown>) {
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.expires_in !== "number" ||
      tokens.expires_in <= 0
    )
      throw new GmailError(
        "Google did not return a usable access token. Reconnect Gmail.",
      );
    return {
      token: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000 - 60000,
    };
  }
  token = async (): Promise<string> => {
    if (this.access && this.access.expires > Date.now())
      return this.access.token;
    if (this.refreshing) return this.refreshing;
    const tokens = this.read<Tokens>(this.tokenFile);
    if (!tokens) throw new HttpError(400, "Connect Gmail in Settings first.");
    this.refreshing = this.exchange({
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    })
      .then((value) => {
        this.access = this.accessToken(value);
        if (typeof value.refresh_token === "string")
          atomicWrite(
            this.tokenFile,
            JSON.stringify({ ...tokens, refreshToken: value.refresh_token }),
          );
        return this.access.token;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  };
  disconnect() {
    this.assertIdle();
    if (existsSync(this.tokenFile)) unlinkSync(this.tokenFile);
    this.access = undefined;
    this.pending = undefined;
    this.error = undefined;
  }
  private assertIdle() {
    if (this.connecting)
      throw new HttpError(409, "Wait for Google authorization to finish.");
  }
}
