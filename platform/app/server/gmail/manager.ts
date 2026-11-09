import { tunable, tunableMs } from "../tunables.js";
import type {
  GmailPreferences,
  GmailScan,
  GmailState,
} from "../../shared/gmail.js";
import { isNegativeReply } from "../../shared/gmail.js";
import {
  applyEmployerReply,
  settlePendingRejections,
} from "./application-updates.js";
import { GmailAuth } from "./auth.js";
import {
  GmailError,
  GmailReconnectError,
  gmailReader,
  type GmailMessage,
  type GmailReader,
} from "./api.js";
import {
  gmailQuery,
  gmailScanVersion,
  matchGmailMessage,
  recordGmailPage,
  startGmailWindow,
} from "./scan.js";
import { type ReplyMatch } from "./matching.js";
import { HttpError, now, Store } from "../storage.js";

export const gmailCheckIntervalMs = 15 * 60_000;
export const gmailContinuationDelayMs = 5_000;
export const gmailConnectingDelayMs = 15_000;
export { gmailQuery, gmailScanVersion } from "./scan.js";

export class GmailManager {
  readonly auth: GmailAuth;
  private running?: Promise<void>;
  private stopping = false;
  private reader: GmailReader;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private backgroundStarted = false;
  constructor(
    private store: Store,
    port: number,
    private publish: () => void,
    reader?: GmailReader,
  ) {
    this.auth = new GmailAuth(store.dataDir, port);
    this.reader =
      reader ??
      gmailReader(this.auth.token, {
        timeoutMs: () => tunableMs(store, "gmail.requestTimeoutS"),
        cooldownMs: () => tunableMs(store, "gmail.errorCooldownMin"),
        pageSize: () => tunable(store, "gmail.pageSize"),
        textLimit: () => tunable(store, "gmail.textLimitChars"),
      });
  }
  preferences(): GmailPreferences {
    return {
      enabled: true,
      autoUpdate: true,
      includeNegative: false,
      ...this.store.get("gmail_preferences", "main"),
    };
  }
  get active() {
    return !!this.running;
  }
  state(): GmailState {
    const connection = this.auth.state();
    const scan = connection.account
      ? this.store.get("gmail_scan", connection.account)
      : undefined;
    const retryTime = Math.max(
      Date.parse(scan?.retryAt ?? "") || 0,
      (Date.parse(scan?.lastAttemptAt ?? "") || 0) +
        tunableMs(this.store, "gmail.manualCooldownS"),
    );
    const preferences = this.preferences();
    const needsRescan =
      !!connection.account && scan?.lastScanVersion !== gmailScanVersion;
    const nextCheck = this.nextCheckTime(scan, preferences.enabled);
    return {
      ...connection,
      ...preferences,
      checking: !!this.running,
      lastCheckedAt: scan?.lastCheckedAt,
      retryAt:
        retryTime > Date.now() ? new Date(retryTime).toISOString() : undefined,
      error: connection.error ?? scan?.error,
      reconnectRequired: !connection.error && !!scan?.reconnect,
      hasMore: scan?.pending?.scanVersion === gmailScanVersion,
      checked: scan?.pending?.checked ?? 0,
      needsRescan,
      nextCheckAt:
        nextCheck && nextCheck > Date.now()
          ? new Date(nextCheck).toISOString()
          : undefined,
      needsNegativeBackfill:
        preferences.includeNegative && !scan?.lastIncludedNegative,
      replies: this.store
        .list("employer_reply")
        .filter(
          (r) =>
            r.account === connection.account &&
            (preferences.includeNegative || !isNegativeReply(r.kind)),
        )
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
    };
  }
  settings(body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      !("enabled" in body) ||
      !("autoUpdate" in body) ||
      typeof body.enabled !== "boolean" ||
      typeof body.autoUpdate !== "boolean" ||
      ("includeNegative" in body && typeof body.includeNegative !== "boolean")
    )
      throw new HttpError(
        400,
        "Choose whether to check Gmail and automatically update clear matches.",
      );
    const previous = this.preferences();
    const includeNegative =
      "includeNegative" in body
        ? (body.includeNegative as boolean)
        : previous.includeNegative;
    if (includeNegative !== previous.includeNegative) {
      this.assertIdle();
      for (const scan of this.store.list("gmail_scan"))
        this.store.put("gmail_scan", scan.account, {
          ...scan,
          pending: undefined,
          lastIncludedNegative: includeNegative
            ? false
            : scan.lastIncludedNegative,
        });
    }
    this.store.put("gmail_preferences", "main", {
      enabled: body.enabled,
      autoUpdate: body.autoUpdate,
      includeNegative,
    });
    this.changed();
    this.wakeBackground();
    return this.state();
  }
  assertIdle() {
    if (this.running)
      throw new HttpError(409, "Wait for the current Gmail check to finish.");
  }
  disconnect() {
    this.assertIdle();
    this.auth.disconnect();
    this.changed();
    return this.state();
  }
  review(id: string) {
    const reply = this.store.get("employer_reply", id);
    if (!reply || reply.account !== this.auth.state().account)
      throw new HttpError(404, "Employer reply not found.");
    this.store.put("employer_reply", id, { ...reply, reviewedAt: now() });
    this.changed();
    return this.state();
  }
  check(manual = false, continuation = false): GmailState {
    const state = this.state();
    if (
      this.running ||
      this.auth.connecting ||
      this.stopping ||
      !state.connected ||
      !state.account ||
      (!manual && !state.enabled)
    )
      return state;
    const scan = this.store.get("gmail_scan", state.account) ?? {
      account: state.account,
    };
    if (Date.parse(scan.retryAt ?? "") > Date.now()) return state;
    const minimum = continuation
      ? 0
      : manual
        ? tunableMs(this.store, "gmail.manualCooldownS")
        : tunableMs(this.store, "gmail.checkIntervalMin");
    if (Date.now() - Date.parse(scan.lastAttemptAt ?? "") < minimum)
      return state;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    scan.lastAttemptAt = now();
    scan.error = undefined;
    scan.reconnect = undefined;
    scan.retryAt = undefined;
    this.store.put("gmail_scan", scan.account, scan);
    this.running = Promise.resolve()
      .then(() => this.scan(scan))
      .catch((error) => {
        // Preserve the successful window and failed page for retry; never report an incomplete search as checked.
        const latest = this.store.get("gmail_scan", scan.account) ?? scan;
        this.store.put("gmail_scan", scan.account, {
          ...latest,
          error:
            error instanceof Error
              ? error.message
              : "Gmail check failed. Try again.",
          retryAt: error instanceof GmailError ? error.retryAt : undefined,
          reconnect: error instanceof GmailReconnectError || undefined,
        });
      })
      .finally(() => {
        this.running = undefined;
        this.changed();
        this.scheduleBackground();
      });
    this.publish();
    return this.state();
  }
  private async scan(scan: GmailScan) {
    const includeNegative = this.preferences().includeNegative;
    const pending = startGmailWindow(
      scan,
      includeNegative,
      Date.now(),
      tunableMs(this.store, "gmail.lookbackDays"),
      tunableMs(this.store, "gmail.overlapDays"),
    );
    this.store.put("gmail_scan", scan.account, scan);
    const seen = new Set<string>();
    const applications = this.store.list("application");
    const openings = this.store.openings();
    const threadCache = new Map<string, Promise<GmailMessage[]>>();
    for (let page = 0; page < 2 && !this.stopping; page++) {
      const result = await this.reader.list(pending.query, pending.pageToken);
      recordGmailPage(pending, result, seen);
      for (let index = 0; index < result.ids.length; index++) {
        if (this.stopping) return;
        const id = result.ids[index];
        seen.add(id);
        const message = await this.reader.message(id);
        if (!message) continue;
        const match = await matchGmailMessage({
          message,
          account: scan.account,
          includeNegative,
          applications,
          openings,
          reader: this.reader,
          threadCache,
        });
        if (match) this.saveReply(match);
      }
      pending.checked += result.ids.length;
      if (!result.nextPageToken) {
        if (includeNegative)
          settlePendingRejections(
            this.store,
            scan.account,
            this.preferences().autoUpdate,
          );
        scan.lastCheckedAt = pending.through;
        scan.lastScanVersion = gmailScanVersion;
        scan.lastIncludedNegative = includeNegative;
        scan.pending = undefined;
        this.store.put("gmail_scan", scan.account, scan);
        return;
      }
      pending.pageToken = result.nextPageToken;
      this.store.put("gmail_scan", scan.account, scan);
      this.publish();
    }
  }
  private saveReply(match: ReplyMatch) {
    const reply = match.reply;
    if (this.store.get("employer_reply", reply.id)) return;
    this.store.transaction(() => {
      const application =
        match.certainApplicationId &&
        this.store.get("application", match.certainApplicationId);
      if (application && this.preferences().autoUpdate) {
        // Full-text search pages are not chronological. Wait for the whole window before rejecting a role.
        if (reply.kind === "rejection")
          reply.pendingApplicationId = application.id;
        else applyEmployerReply(this.store, reply, application);
      }
      this.store.put("employer_reply", reply.id, reply);
    });
  }
  private changed() {
    this.store.autoExport();
    this.publish();
  }
  startBackground() {
    if (this.stopping || this.backgroundTimer) return;
    this.backgroundStarted = true;
    this.scheduleBackground(0);
  }
  wakeBackground() {
    if (!this.backgroundStarted) return;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.scheduleBackground(0);
  }
  /** A saved timing change applies to the check already waiting: recompute its
   * delay from the live values instead of keeping the one it was armed with. */
  rescheduleBackground() {
    if (!this.backgroundStarted || this.stopping || !this.backgroundTimer)
      return;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.scheduleBackground();
  }
  private nextCheckTime(scan: GmailScan | undefined, enabled: boolean) {
    if (!enabled || !scan) return undefined;
    const retryAt = Date.parse(scan.retryAt ?? "") || 0;
    if (retryAt > Date.now()) return retryAt;
    const lastAttempt = Date.parse(scan.lastAttemptAt ?? "") || 0;
    return scan.pending && !scan.error
      ? lastAttempt + tunableMs(this.store, "gmail.continueDelayS")
      : lastAttempt + tunableMs(this.store, "gmail.checkIntervalMin");
  }
  private scheduleBackground(delay?: number) {
    if (!this.backgroundStarted || this.stopping || this.backgroundTimer)
      return;
    const state = this.state();
    if (!state.enabled) return;
    const scan = state.account
      ? this.store.get("gmail_scan", state.account)
      : undefined;
    const due =
      delay ??
      Math.max(
        0,
        (this.nextCheckTime(scan, true) ??
          Date.now() + tunableMs(this.store, "gmail.checkIntervalMin")) -
          Date.now(),
      );
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      const current = this.state();
      const latest = current.account
        ? this.store.get("gmail_scan", current.account)
        : undefined;
      this.check(false, !!latest?.pending);
      if (!this.running) {
        const next = this.nextCheckTime(latest, current.enabled);
        const delay = this.auth.connecting
          ? tunableMs(this.store, "gmail.connectingRetryS")
          : next
            ? Math.max(1_000, next - Date.now())
            : tunableMs(this.store, "gmail.checkIntervalMin");
        this.scheduleBackground(delay);
      }
    }, due);
    this.backgroundTimer.unref?.();
  }
  async close() {
    this.stopping = true;
    this.backgroundStarted = false;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    await this.running;
  }
}
