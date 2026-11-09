import { LiveGreenhouseSource } from "../../server/greenhouse-source.js";

type PageBehavior = {
  status?: number;
  failed?: boolean;
  noRequest?: boolean;
  bodyError?: string;
  noticeHtml?: string;
  noticeAtPoll?: number;
  responseAfterPolls?: number;
  pendingPolls?: number;
  extra429?: string;
  signin?: boolean;
  driverError?: boolean;
};
type Options = {
  userscript?: boolean;
  fillNoRequest?: boolean;
  behavior?: (page: number, attempt: number) => PageBehavior;
  publicStatus?: number;
  bridgeFailure?: (command: string) => Response | undefined;
  // Real Kapture reports the tab URL without its fragment for a while after
  // a navigation; false reproduces that.
  reportFragment?: boolean;
  // Real Kapture can briefly report the URL of the page's latest search
  // request (including userscript fetches) as the tab URL.
  reportLastRequest?: boolean;
};
type Call = { name: string; body: Record<string, unknown>; at: number };
type Request = {
  requestId: string;
  url: string;
  status?: number;
  failed?: boolean;
  mimeType: string;
};
const initialUrl = "https://williamkapke.github.io/kapture/how-to.html";

class BrowserFixture {
  clock = Date.parse("2026-09-28T20:00:00Z");
  tabUrl = initialUrl;
  tabExists = false;
  calls: Call[] = [];
  requests: Request[] = [];
  bodies = new Map<string, object>();
  private attempts = new Map<string, number>();
  private behavior: PageBehavior = {};
  private polls = 0;
  private deferred = false;
  private pendingUrl = "";
  commandInput = false;
  constructor(private options: Options) {}

  private capture(url: string, shell = false) {
    const page = Number(new URL(url).searchParams.get("page"));
    const requestId = String(this.requests.length + 1);
    this.requests.push({
      requestId,
      url,
      mimeType: shell ? "text/html" : "application/json",
      status: this.behavior.pendingPolls
        ? undefined
        : (this.behavior.status ?? 200),
      failed: this.behavior.failed,
    });
    const payload = {
      component: "jobs",
      url,
      props: shell
        ? {}
        : {
            page,
            moreResultsAvailable: page < 3,
            jobPosts: [
              {
                id: page,
                urlToken: "example",
                title: "Software Engineer",
                companyName: "Example",
              },
            ],
          },
      ...(shell
        ? {
            deferredProps: {
              jobPosts: ["page", "moreResultsAvailable", "jobPosts"],
            },
          }
        : {}),
    };
    this.bodies.set(requestId, {
      body: shell
        ? `<div data-page="${JSON.stringify(payload).replaceAll('"', "&quot;")}"></div>`
        : JSON.stringify(payload),
      bodyError: this.behavior.bodyError,
      responseHeaders: { "Retry-After": "300" },
    });
  }

  private navigate(url: string, reload = false) {
    const target = new URL(url);
    const previous = new URL(this.tabUrl);
    this.commandInput = false;
    this.tabUrl = url;
    if (
      target.origin + target.pathname + target.search ===
        previous.origin + previous.pathname + previous.search &&
      target.hash !== previous.hash &&
      !reload
    )
      return;
    target.hash = "";
    this.beginRequest(target.href);
    this.commandInput = Boolean(
      this.options.userscript &&
      new URL(url).hash.startsWith("#fieldwork-pull="),
    );
  }
  private beginRequest(url: string) {
    this.pendingUrl = url;
    const attempt = (this.attempts.get(url) ?? 0) + 1;
    this.attempts.set(url, attempt);
    this.behavior =
      this.options.behavior?.(
        Number(new URL(url).searchParams.get("page")),
        attempt,
      ) ?? {};
    this.polls = 0;
    this.deferred = Boolean(this.behavior.responseAfterPolls);
    if (!this.behavior.noRequest) this.capture(url, this.deferred);
    if (this.behavior.extra429) {
      const requestId = String(this.requests.length + 1);
      this.requests.push({
        requestId,
        url: this.behavior.extra429,
        status: 429,
        mimeType: "application/json",
      });
      this.bodies.set(requestId, { responseHeaders: { "Retry-After": "300" } });
    }
    if (this.behavior.signin)
      this.tabUrl = "https://my.greenhouse.io/users/sign_in";
  }

  private network(body: Record<string, unknown>) {
    if (body.since !== undefined) {
      this.polls++;
      if (
        this.behavior.pendingPolls &&
        this.polls > this.behavior.pendingPolls
      ) {
        const request = this.requests.at(-1);
        if (request) request.status = this.behavior.status ?? 200;
      }
      if (
        this.deferred &&
        this.polls > (this.behavior.responseAfterPolls ?? 0)
      ) {
        this.capture(this.pendingUrl);
        this.deferred = false;
      }
    }
    return {
      cursor: this.requests.length,
      requests:
        body.since === undefined
          ? this.requests.slice(-1)
          : this.requests.slice(Number(body.since)),
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    const name = route.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    this.calls.push({ name, body, at: this.clock });
    const failure = this.options.bridgeFailure?.(name);
    if (failure) return failure;
    let data: unknown = {};
    if (route === "/tabs") {
      this.tabExists = true;
      this.tabUrl = initialUrl;
      data = { tabId: "owned" };
    } else if (route === "/tab/owned") {
      if (!this.tabExists)
        return new Response(JSON.stringify({ error: "Tab not found" }), {
          status: 404,
        });
      const lastSearch = [...this.requests]
        .reverse()
        .find((request) => request.url.includes("/jobs/search"))?.url;
      data = {
        url:
          this.options.reportLastRequest && lastSearch
            ? lastSearch
            : this.options.reportFragment === false
              ? this.tabUrl.split("#", 1)[0]
              : this.tabUrl,
      };
    } else if (name === "navigate") this.navigate(String(body.url));
    else if (name === "reload") this.navigate(this.tabUrl, true);
    else if (name === "fill") {
      if (!this.commandInput)
        return new Response(
          JSON.stringify({ success: false, error: "No matching element" }),
        );
      const command = JSON.parse(String(body.value));
      if (
        body.selector !== "#fieldwork-search-command" ||
        command.nonce !==
          new URLSearchParams(new URL(this.tabUrl).hash.slice(1)).get(
            "fieldwork-pull",
          )
      )
        throw Error("Invalid fixture search command");
      if (!this.options.fillNoRequest) this.beginRequest(command.url);
    } else if (name === "network_requests") data = this.network(body);
    else if (name === "network_body")
      data = this.bodies.get(String(body.requestId));
    else if (name === "dom")
      data = {
        url: this.tabUrl,
        html: `<html ${this.behavior.driverError ? `data-fieldwork-search-error="${new URLSearchParams(new URL(this.tabUrl).hash.slice(1)).get("fieldwork-pull")}"` : ""}><body>${this.polls >= (this.behavior.noticeAtPoll ?? 0) ? (this.behavior.noticeHtml ?? "") : ""}Posted today</body></html>`,
      };
    else if (name !== "network_monitor")
      throw Error(`Unexpected browser command: ${name}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };

  publicFetch = async (url: string) => {
    this.calls.push({ name: "public", body: { url }, at: this.clock });
    return {
      url,
      requestedUrl: url,
      status: this.options.publicStatus ?? 200,
      type: "application/json",
      at: new Date(this.clock).toISOString(),
      retryAfter: "300",
      text: JSON.stringify(
        url.endsWith("/jobs")
          ? { jobs: [{ id: 1 }, { id: 2 }] }
          : {
              id: Number(url.split("/").at(-1)),
              title: "Engineer",
              content: "<p>Build software</p>",
            },
      ),
    };
  };
}

export function greenhouseBrowserFixture(options: Options = {}) {
  const browser = new BrowserFixture(options);
  let ownedTab = "";
  const source = () =>
    new LiveGreenhouseSource(
      {
        read: () => ownedTab,
        write: (tab) => {
          ownedTab = tab;
        },
      },
      browser.fetch,
      {
        clock: () => browser.clock,
        wait: async (ms) => {
          browser.clock += ms;
        },
        publicFetch: browser.publicFetch,
      },
    );
  return {
    source: source(),
    newSource: source,
    calls: browser.calls,
    time: () => browser.clock,
    setTime: (at: number) => {
      browser.clock = at;
    },
    location: () => browser.tabUrl,
    navigateAway: (url: string) => {
      browser.tabUrl = url;
    },
    removeTab: () => {
      browser.tabExists = false;
    },
    replacePage: () => {
      browser.commandInput = false;
    },
  };
}
