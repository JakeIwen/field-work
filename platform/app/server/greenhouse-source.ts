import {
  browserTransportHeaders,
  liveBrowserOrigin,
} from "./browser-service.js";
import {
  searchUrl,
  validateSearchIdentity,
  parseGreenhouseResponse,
  GreenhouseSearchTransient,
  type GreenhousePage,
} from "./greenhouse-search.js";
export {
  searchUrl,
  parseSearch,
  GreenhouseSearchTransient,
  type GreenhousePage,
} from "./greenhouse-search.js";
import { load } from "cheerio";
import { publicCareersFetch } from "./careers/http.js";
import {
  greenhouseSearchIdentity,
  greenhouseDefaultPacingMs,
  type GreenhouseSearchTransport,
  type GreenhouseEmploymentType,
  type GreenhouseSearch,
} from "../shared/greenhouse-search.js";

import {
  tunables,
  tunableValue,
  type TunableSettings,
} from "../shared/tunables.js";
export const greenhouseCooldownMs =
  tunables["greenhouse.baseCooldownS"].default * 1000;
const navigationWaitMs = 30000;
const searchCommandSelector = "#fieldwork-search-command";
const limitNoticePattern =
  /\b(?:api|rate|request)[\s-]*limit|\btoo many requests\b/i;
const noticeSelector =
  '[role="alert"], [role="status"], [aria-live], [class*="toast" i], [class*="notification" i], [class*="snackbar" i]';

export { greenhouseQueries } from "./greenhouse-query-plan.js";
export type {
  PullCard as GreenhouseCard,
  PullPosting as GreenhousePosting,
} from "./opening-pull/contract.js";
import type {
  PullCard as GreenhouseCard,
  PullPosting as GreenhousePosting,
} from "./opening-pull/contract.js";
export class GreenhouseLimit extends Error {
  constructor(
    message: string,
    public retryAt: string,
  ) {
    super(message);
  }
}
export function retryTime(
  value?: string,
  at = Date.now(),
  cooldownMs = greenhouseCooldownMs,
) {
  const seconds = Number(value);
  const parsed =
    value && Number.isFinite(seconds)
      ? at + seconds * 1000
      : Date.parse(value || "");
  return new Date(
    Math.max(at + cooldownMs, Number.isFinite(parsed) ? parsed : 0),
  ).toISOString();
}
export class GreenhouseSearchCancelled extends Error {}
export class GreenhouseBridgeTransient extends Error {}
export type GreenhousePageOptions = {
  nonce: string;
  pacingRate: number;
  onTransport?: (transport: GreenhouseSearchTransport, note?: string) => void;
};
type SearchSession = {
  location: string;
  nonce?: string;
};
export interface GreenhouseSource {
  page(
    query: string,
    page: number,
    employmentTypes?: GreenhouseEmploymentType[],
    options?: GreenhousePageOptions,
  ): Promise<GreenhousePage>;
  cancelSearch?(nonce?: string): Promise<void>;
  posting(card: GreenhouseCard): Promise<GreenhousePosting | null>;
  close(): Promise<void>;
}

type GreenhouseSearchRequest = {
  url: string;
  requestId: string;
  status?: number;
  failed?: boolean;
  mimeType?: string;
};

const withoutFragment = (value: string) => value.split("#", 1)[0];

/** Fixed, task-scoped commands through the installed browser_live driver.
 * Never launches a browser process, reads cookies, or reuses a user's tab. */
export class LiveGreenhouseSource implements GreenhouseSource {
  private tab = "";
  private lastSearchRequest = -Infinity;
  private searchSession?: SearchSession;
  private searchEpoch = 0;
  private needsNavigation = false;
  private lastPublicRequest = -Infinity;
  private boards = new Map<string, any[]>();
  constructor(
    private ownedTab?: { read: () => string; write: (id: string) => void },
    private fetcher: typeof fetch = fetch,
    private dependencies: {
      settings?: () => TunableSettings;
      clock?: () => number;
      wait?: (ms: number) => Promise<void>;
      publicFetch?: typeof publicCareersFetch;
    } = {},
  ) {
    this.tab = ownedTab?.read() ?? "";
  }
  private async bridge(
    route: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await this.fetcher(`${liveBrowserOrigin()}${route}`, {
      method,
      headers: {
        ...browserTransportHeaders(),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(
        tunableValue(
          this.dependencies.settings?.() ?? {},
          "greenhouse.bridgeTimeoutS",
        ) * 1000,
      ),
    }).catch((error) => {
      throw new GreenhouseBridgeTransient(
        `Chrome connection: ${String(error)}`,
      );
    });
    if (response.status >= 500)
      throw new GreenhouseBridgeTransient(
        `Chrome connection: bridge HTTP ${response.status}`,
      );
    const data = (await response.json().catch((error) => {
      throw new GreenhouseBridgeTransient(
        `Chrome connection: ${String(error)}`,
      );
    })) as any;
    if (!response.ok || data.success === false || data.error) {
      const reason =
        typeof data.error === "string"
          ? data.error
          : data.error?.message || String(response.status);
      const missingInput =
        route.endsWith("/fill") &&
        /no matching element|(?:element|selector).*not found/i.test(reason);
      const missingTab =
        !missingInput &&
        (response.status === 404 ||
          /tab.*(?:not found|not connected|closed)/i.test(reason));
      if (missingTab) {
        this.searchSession = undefined;
        this.tab = "";
        this.ownedTab?.write("");
      }
      const message = `Chrome connection: ${reason}. Check the configured browser bridge service and its health endpoint, then retry.`;
      if (
        missingTab ||
        /timed?\s*out|timeout|not connected|disconnected|connection/i.test(
          reason,
        )
      )
        throw new GreenhouseBridgeTransient(message);
      throw Error(message);
    }
    return data;
  }
  private clock() {
    return this.dependencies.clock?.() ?? Date.now();
  }
  private wait(ms: number) {
    return (
      this.dependencies.wait?.(ms) ??
      new Promise<void>((resolve) => setTimeout(resolve, ms))
    );
  }
  private async pace(
    kind: "search" | "public",
    pacingRate = greenhouseDefaultPacingMs,
  ) {
    const last =
      kind === "public" ? this.lastPublicRequest : this.lastSearchRequest;
    const spacing =
      kind === "public"
        ? tunableValue(
            this.dependencies.settings?.() ?? {},
            "greenhouse.publicApiSpacingMs",
          )
        : pacingRate;
    const delay = spacing - (this.clock() - last);
    if (delay > 0) await this.wait(delay);
    if (kind === "public") this.lastPublicRequest = this.clock();
    else this.lastSearchRequest = this.clock();
  }
  private async command(name: string, args: any) {
    return this.bridge(`/tab/${encodeURIComponent(this.tab)}/${name}`, args);
  }
  private taskUrl(value: string) {
    try {
      const u = new URL(value);
      return (
        u.origin === "https://my.greenhouse.io" ||
        (u.origin === "https://williamkapke.github.io" &&
          u.pathname === "/kapture/how-to.html")
      );
    } catch {
      return false;
    }
  }
  private async checkOwnedTab() {
    const detail = await this.bridge(`/tab/${encodeURIComponent(this.tab)}`);
    if (!this.taskUrl(detail.url)) {
      this.tab = "";
      this.ownedTab?.write("");
      throw Error(
        "The Greenhouse tab was navigated elsewhere. It was left untouched. Retry to create a separate search tab.",
      );
    }
    return detail;
  }
  private async prepareTab(replaceMissing = true): Promise<string> {
    if (!this.tab) {
      const tab = await this.bridge("/tabs", { browser: "chrome" });
      if (!tab.tabId)
        throw new GreenhouseBridgeTransient(
          "Chrome did not connect the Greenhouse tab. Check the configured browser bridge service and its health endpoint.",
        );
      this.tab = String(tab.tabId);
      this.ownedTab?.write(this.tab);
    }
    let detail;
    try {
      detail = await this.checkOwnedTab();
    } catch (error) {
      if (!this.tab && replaceMissing) return this.prepareTab(false);
      throw error;
    }
    if (/\/(?:users\/sign_in|sign_in|login)(?:[/?#]|$)/.test(detail.url))
      throw Error("Sign in to MyGreenhouse in Chrome, then resume this pull.");
    await this.command("network_monitor", {
      enabled: true,
      clientId: "fieldwork-greenhouse",
    });
    return String(detail.url);
  }
  async page(
    query: string,
    page: number,
    employmentTypes?: GreenhouseEmploymentType[],
    options?: GreenhousePageOptions,
  ): Promise<GreenhousePage> {
    const search = { query, employmentTypes };
    const url = searchUrl(query, page, employmentTypes);
    if (options && !/^[A-Za-z0-9-]{8,64}$/.test(options.nonce))
      throw Error("Invalid Greenhouse userscript configuration");
    const epoch = this.searchEpoch;
    const location = this.sessionLocation(await this.prepareTab());
    let note: string | undefined;
    if (
      options &&
      !this.needsNavigation &&
      this.commandTab(location, options.nonce)
    ) {
      // Keep the activated URL; the reported location may lack its fragment.
      if (this.searchSession?.nonce !== options.nonce)
        this.searchSession = { location, nonce: options.nonce };
      const result = await this.commandSearch(
        search,
        page,
        url,
        epoch,
        options,
      );
      if (result) {
        options.onTransport?.("userscript");
        return result;
      }
      note = "MyGreenhouse userscript not detected; loading pages by URL";
    }
    options?.onTransport?.("navigation", note);
    return this.navigateSearch(search, page, url, epoch, location, options);
  }
  // Kapture's reported tab URL lags our activated navigation (no fragment)
  // and can briefly show a URL the userscript fetched. Commands never move the
  // document, so while the tab is on the search page the activated URL is the
  // real one; a real page change removes the command input and falls back.
  private sessionLocation(reported: string) {
    const session = this.searchSession?.location;
    if (!session) return reported;
    const url = new URL(reported);
    return url.origin === "https://my.greenhouse.io" &&
      url.pathname === "/jobs/search"
      ? session
      : reported;
  }
  private commandTab(location: string, nonce: string) {
    const url = new URL(location);
    if (
      url.origin !== "https://my.greenhouse.io" ||
      url.pathname !== "/jobs/search"
    )
      return false;
    const fragment = new URLSearchParams(url.hash.slice(1));
    return (
      fragment.getAll("fieldwork-pull").length === 1 &&
      fragment.get("fieldwork-pull") === nonce
    );
  }
  private async commandSearch(
    search: GreenhouseSearch,
    page: number,
    url: string,
    epoch: number,
    options: GreenhousePageOptions,
  ) {
    const before = await this.command("network_requests", { limit: 1 });
    await this.pace("search", options.pacingRate);
    if (epoch !== this.searchEpoch) throw new GreenhouseSearchCancelled();
    try {
      await this.command("fill", {
        selector: searchCommandSelector,
        value: JSON.stringify({ nonce: options.nonce, url }),
      });
    } catch (error) {
      if (error instanceof GreenhouseBridgeTransient) throw error;
      return undefined;
    }
    return this.waitForSearch(search, page, before.cursor ?? 0, epoch, true);
  }
  private async navigateSearch(
    search: GreenhouseSearch,
    page: number,
    url: string,
    epoch: number,
    location: string,
    options?: GreenhousePageOptions,
  ) {
    if (options) url += `#fieldwork-pull=${options.nonce}`;
    location = await this.prepareNavigation(url, location);
    const before = await this.command("network_requests", { limit: 1 });
    await this.pace("search", options?.pacingRate);
    if (epoch !== this.searchEpoch) throw new GreenhouseSearchCancelled();
    this.searchSession = { location: url, nonce: options?.nonce };
    if (url === location) await this.command("reload", {});
    else await this.command("navigate", { url, timeout: navigationWaitMs });
    const result = await this.waitForSearch(
      search,
      page,
      before.cursor ?? 0,
      epoch,
    );
    if (!result) throw this.incompleteSearch(search, page);
    this.needsNavigation = false;
    return result;
  }
  private async prepareNavigation(url: string, location: string) {
    const target = new URL(url),
      current = new URL(location);
    const sameDocument =
      target.origin + target.pathname + target.search ===
      current.origin + current.pathname + current.search;
    if (!sameDocument || target.hash === current.hash) return location;
    // Fragment-only navigate times out in Kapture. Replace only our unchanged
    // owned tab when a new activation would otherwise require that operation.
    const detail = await this.checkOwnedTab();
    if (this.sessionLocation(String(detail.url)) !== location)
      throw Error(
        "The Greenhouse tab changed before activation. Retry the saved page.",
      );
    await this.bridge(
      `/tab/${encodeURIComponent(this.tab)}`,
      undefined,
      "DELETE",
    );
    this.tab = "";
    this.ownedTab?.write("");
    this.searchSession = undefined;
    return this.prepareTab();
  }
  async cancelSearch(_nonce?: string) {
    // A driver only sends one GET per command. There is no autonomous work to
    // stop, and invalidating this read is enough to prevent a paused publication.
    this.searchEpoch++;
  }
  private incompleteSearch(search: GreenhouseSearch, page: number) {
    return new GreenhouseSearchTransient(
      `Greenhouse search “${greenhouseSearchIdentity(search).label}”, page ${page} did not finish loading. The page remains pending.`,
    );
  }
  private async waitForSearch(
    search: GreenhouseSearch,
    page: number,
    cursor: number,
    epoch: number,
    allowMissing = false,
  ) {
    const started = this.clock();
    let requested = false;
    for (;;) {
      if (epoch !== this.searchEpoch) throw new GreenhouseSearchCancelled();
      const result = await this.inspectSearch(search, page, cursor);
      if (epoch !== this.searchEpoch) throw new GreenhouseSearchCancelled();
      if (result.page) return result.page;
      requested ||= result.requested;
      const elapsed = this.clock() - started;
      if (
        allowMissing &&
        !requested &&
        elapsed >=
          tunableValue(
            this.dependencies.settings?.() ?? {},
            "greenhouse.userscriptDetectS",
          ) *
            1000
      )
        return undefined;
      if (elapsed >= navigationWaitMs)
        throw this.incompleteSearch(search, page);
      await this.wait(
        tunableValue(
          this.dependencies.settings?.() ?? {},
          "greenhouse.noticePollMs",
        ),
      );
    }
  }
  private async inspectSearch(
    search: GreenhouseSearch,
    page: number,
    cursor: number,
  ) {
    const { query, employmentTypes } = search;
    const label = greenhouseSearchIdentity(search).label;
    const log = await this.command("network_requests", {
      since: cursor,
      limit: 1000,
    });
    const requests = (log.requests ?? []).filter(
      (r: GreenhouseSearchRequest) => {
        try {
          validateSearchIdentity(r.url, query, page, employmentTypes);
          return true;
        } catch {
          return false;
        }
      },
    ) as GreenhouseSearchRequest[];
    const bad = requests.find(
      (r) => r.failed || (r.status && r.status !== 200),
    );
    if (bad?.status === 409) this.needsNavigation = true;
    await this.checkSearchNotices(search, page, log.requests ?? [], bad);
    // Full navigations may return HTML with embedded Inertia data, not JSON.
    const response = [...requests]
      .reverse()
      .find((r) => r.status === 200 && /json|html/.test(r.mimeType ?? ""));
    if (!response) return { requested: requests.length > 0 };
    let captured;
    try {
      captured = await this.command("network_body", {
        requestId: response.requestId,
        maxBytes: 1024 * 1024,
      });
    } catch (error) {
      if (error instanceof GreenhouseBridgeTransient) throw error;
      throw new GreenhouseSearchTransient(
        `Greenhouse search “${label}”, page ${page}: response capture failed: ${String(error)}`,
      );
    }
    return {
      requested: true,
      page: parseGreenhouseResponse(
        captured,
        query,
        page,
        employmentTypes,
        response.url,
      ),
    };
  }
  private async checkSearchNotices(
    search: GreenhouseSearch,
    page: number,
    requests: GreenhouseSearchRequest[],
    failed?: GreenhouseSearchRequest,
  ) {
    await this.checkOwnedTab();
    const dom = await this.bridge(`/tab/${encodeURIComponent(this.tab)}/dom`);
    if (dom.url && !dom.url.startsWith("https://my.greenhouse.io/jobs/search"))
      throw Error("Sign in to MyGreenhouse in Chrome, then resume this pull.");
    if (
      dom.url &&
      withoutFragment(dom.url) !==
        withoutFragment(this.searchSession?.location ?? "")
    )
      throw Error("Greenhouse search tab changed. Search remains incomplete.");
    const $ = load(dom.html || "");
    $(
      "script, style, [hidden], [aria-hidden='true'], .sr-only, .visually-hidden, [class*='a11yText']",
    ).remove();
    $("[style]").each((_index, node) => {
      const style = $(node).attr("style") ?? "";
      const tinyLiveRegion =
        /(?:^|;)\s*width\s*:\s*[0-4]px\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*height\s*:\s*[0-4]px\s*(?:;|$)/i.test(style);
      if (
        /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style) ||
        tinyLiveRegion
      )
        $(node).remove();
    });
    const reported = $("html").attr("data-fieldwork-search-error");

    const notices = $(noticeSelector)
      .toArray()
      .filter(
        (node) =>
          !$(node).closest('[hidden], [aria-hidden="true"]').length &&
          !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(
            $(node).attr("style") ?? "",
          ),
      )
      .map((node) => $(node).text().trim())
      .filter(Boolean);
    const limited = requests.filter((r) => {
      try {
        return (
          new URL(r.url).origin === "https://my.greenhouse.io" &&
          r.status === 429
        );
      } catch {
        return false;
      }
    });
    if (
      limited.length ||
      [...notices, $("body").text()].some((text) =>
        limitNoticePattern.test(text),
      )
    ) {
      await this.searchLimit(
        greenhouseSearchIdentity(search).label,
        page,
        limited[0],
      );
    }
    if (failed)
      throw new GreenhouseSearchTransient(
        `Greenhouse search “${greenhouseSearchIdentity(search).label}”, page ${page}: HTTP ${failed.status || "unavailable"}${failed.failed ? " (request failed)" : ""}.`,
      );
    if (notices.length || (reported && reported === this.searchSession?.nonce))
      throw new GreenhouseSearchTransient(
        "MyGreenhouse displayed an error notification; the same page will resume after cooldown.",
      );
  }
  private async searchLimit(
    query: string,
    page: number,
    limited?: GreenhouseSearchRequest,
  ): Promise<never> {
    let retry: string | undefined;
    if (limited) {
      try {
        const body = await this.command("network_body", {
          requestId: limited.requestId,
          maxBytes: 1000,
        });
        retry = Object.entries(body.responseHeaders ?? {}).find(
          ([key]) => key.toLowerCase() === "retry-after",
        )?.[1] as string;
      } catch {
        /* Preserve the limit even without a readable body. */
      }
    }
    throw new GreenhouseLimit(
      `Greenhouse limited search “${query}”, page ${page}. The same page will resume after cooldown.`,
      retryTime(
        retry,
        this.clock(),
        tunableValue(
          this.dependencies.settings?.() ?? {},
          "greenhouse.baseCooldownS",
        ) * 1000,
      ),
    );
  }
  private async json(url: string) {
    await this.pace("public");
    const response = await (
      this.dependencies.publicFetch ?? publicCareersFetch
    )(url, AbortSignal.timeout(30000)).catch((error) => {
      throw Error(
        `Could not read ${url}: ${String(error)}. Retry keeps this candidate pending.`,
      );
    });
    if (response.status === 429)
      throw new GreenhouseLimit(
        `Greenhouse API limit at ${url}`,
        retryTime(
          response.retryAfter,
          this.clock(),
          tunableValue(
            this.dependencies.settings?.() ?? {},
            "greenhouse.baseCooldownS",
          ) * 1000,
        ),
      );
    if ([404, 410].includes(response.status)) return null;
    if (response.status !== 200)
      throw Error(`Greenhouse API HTTP ${response.status}: ${url}`);
    return JSON.parse(response.text);
  }
  async posting(card: GreenhouseCard): Promise<GreenhousePosting | null> {
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(card.board)}/jobs`;
    const apiUrl = `${base}/${card.id}`;
    const raw = await this.json(apiUrl);
    if (!raw) return null;
    if (
      String(raw.id) !== card.id ||
      !raw.content ||
      typeof raw.title !== "string"
    )
      throw Error(
        "Greenhouse API returned an incomplete or mismatched posting.",
      );
    if (!this.boards.has(card.board)) {
      const board = await this.json(base);
      if (!Array.isArray(board?.jobs))
        throw Error(
          "Could not verify employer requisition aliases. Retry before adding.",
        );
      this.boards.set(
        card.board,
        board.jobs.map((j: any) => ({
          id: String(j.id),
          internal_job_id: j.internal_job_id,
        })),
      );
    }
    const aliases =
      raw.internal_job_id == null
        ? [card.id]
        : this.boards
            .get(card.board)!
            .filter(
              (j) => String(j.internal_job_id) === String(raw.internal_job_id),
            )
            .map((j) => j.id);
    // Greenhouse often encodes HTML once inside the JSON content.
    const decoded = load(raw.content).text();
    const $ = load(
      /<\/?(?:p|div|ul|li|h[1-6])\b/i.test(decoded) ? decoded : raw.content,
    );
    $("br").replaceWith("\n");
    $("p, li, h1, h2, h3, div").append("\n");
    return {
      raw,
      text: $.text()
        .replace(/\n[ \t]+/g, "\n")
        .trim(),
      apiUrl,
      aliases: [...new Set([card.id, ...aliases])],
      fetchedAt: new Date().toISOString(),
    };
  }
  async close() {
    const tab = this.tab;
    this.tab = "";
    this.ownedTab?.write("");
    this.boards.clear();
    if (tab) {
      const detail = await this.bridge(`/tab/${encodeURIComponent(tab)}`);
      if (this.taskUrl(detail.url))
        await this.bridge(
          `/tab/${encodeURIComponent(tab)}`,
          undefined,
          "DELETE",
        );
    }
  }
}
