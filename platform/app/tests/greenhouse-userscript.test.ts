import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { searchUrl } from "../server/greenhouse-search.js";

const packaged = new URL(
  "../../automation/greenhouse/fieldwork-search.user.js",
  import.meta.url,
);
const source = readFileSync(
  existsSync(packaged)
    ? packaged
    : new URL(
        "../../../automation/greenhouse/fieldwork-search.user.js",
        import.meta.url,
      ),
  "utf8",
);
const nonce = "run-12345678";
const startUrl = searchUrl("software engineer", 1, ["contract"]);
const pageData = (page: number, more = page < 3) => ({
  component: "jobs",
  version: "inertia-version",
  props: { page, moreResultsAvailable: more, jobPosts: [] },
});
type Reply = { status: number; json: () => Promise<unknown> };
type Options = {
  hash?: string;
  initial?: object;
  reply?: (page: number, signal: AbortSignal) => Promise<Reply>;
};

function userscriptDocument(options: Options) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: `${startUrl}${options.hash ?? `#fieldwork-pull=${nonce}`}`,
    runScripts: "outside-only",
  });
  dom.window.document
    .querySelector("#app")!
    .setAttribute("data-page", JSON.stringify(options.initial ?? pageData(1)));
  dom.window.document.cookie = "MYGREENHOUSE-XSRF-TOKEN=fixture%2Dcsrf";
  // jsdom has no layout; this models the site's 1x1 select live region separately from a visible notice.
  Object.defineProperty(
    dom.window.HTMLElement.prototype,
    "getBoundingClientRect",
    {
      value(this: HTMLElement) {
        return "screenReader" in this.dataset
          ? { width: 1, height: 1 }
          : { width: 300, height: 40 };
      },
    },
  );
  return dom;
}

function userscriptFixture(options: Options = {}) {
  const { window } = userscriptDocument(options);
  let clock = 0,
    nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: {
    url: string;
    headers: object;
    credentials: string;
    redirect: string;
    method: string;
  }[] = [];
  window.setTimeout = ((callback: () => void, delay: number) => {
    const id = ++nextId;
    timers.set(id, { at: clock + delay, callback });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  window.setInterval = (() => ++nextId) as typeof window.setInterval;
  window.clearInterval = () => {};
  window.fetch = (async (input: string, init: RequestInit) => {
    calls.push({
      url: input,
      headers: JSON.parse(JSON.stringify(init.headers)),
      credentials: init.credentials!,
      redirect: init.redirect!,
      method: init.method!,
    });
    const page = Number(new URL(input).searchParams.get("page"));
    return options.reply
      ? options.reply(page, init.signal as AbortSignal)
      : { status: 200, json: async () => pageData(page) };
  }) as typeof fetch;
  window.eval(source);
  async function flush() {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  }
  async function run() {
    for (let i = 0; i < 400; i++) {
      await flush();
      const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) return;
      timers.delete(entry[0]);
      clock = entry[1].at;
      entry[1].callback();
    }
  }
  const input = () =>
    window.document.querySelector<HTMLInputElement>(
      "#fieldwork-search-command",
    );
  const send = (value: unknown) => {
    const field = input();
    assert.ok(field);
    field.value = typeof value === "string" ? value : JSON.stringify(value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    field.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  return {
    window,
    calls,
    input,
    send,
    flush,
    run,
    error: () =>
      window.document.documentElement.getAttribute(
        "data-fieldwork-search-error",
      ),
    close: () => window.close(),
  };
}

test("activated userscript stays idle until a command, then sends one exact Inertia GET for any search", async () => {
  const f = userscriptFixture({ initial: pageData(1, false) });
  try {
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.input()!.tabIndex, -1);
    assert.equal(f.input()!.getAttribute("aria-hidden"), "true");
    assert.equal(f.input()!.style.width, "8px");
    const url = searchUrl("backend", 7, ["part_time", "temporary"]);
    f.send({ nonce, url });
    await f.run();
    assert.equal(f.input()!.value, "");
    assert.equal(f.error(), null);
    assert.deepEqual(f.calls, [
      {
        url,
        credentials: "include",
        redirect: "error",
        method: "GET",
        headers: {
          Accept: "text/html, application/xhtml+xml",
          "X-Inertia": "true",
          "X-Inertia-Partial-Component": "jobs",
          "X-Inertia-Partial-Data": "jobPosts,moreResultsAvailable,page",
          "X-Requested-With": "XMLHttpRequest",
          "X-Inertia-Version": "inertia-version",
          "X-CSRF-TOKEN": "fixture-csrf",
        },
      },
    ]);
    f.window.document.cookie = "MYGREENHOUSE-XSRF-TOKEN=updated%20token";
    f.send({ nonce, url: searchUrl("frontend", 1) });
    await f.run();
    assert.equal(f.calls.length, 2);
    assert.equal(
      (f.calls[1].headers as Record<string, string>)["X-CSRF-TOKEN"],
      "updated token",
    );
    assert.equal(f.window.location.href, `${startUrl}#fieldwork-pull=${nonce}`);
  } finally {
    f.close();
  }
});

test("ordinary or invalid activation pages inject no command input and make no requests", async () => {
  for (const hash of [
    "",
    "#fieldwork-pull=short",
    `#fieldwork-pull=${nonce}&fieldwork-pull=${nonce}`,
    `#fieldwork-pull=${"a".repeat(65)}`,
    "#fieldwork-pull=invalid%3Fnonce",
  ]) {
    const f = userscriptFixture({ hash });
    try {
      await f.run();
      assert.equal(f.input(), null);
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
});

test("commands reject foreign URLs, unknown or invalid parameters, incorrect nonces and malformed payloads", async () => {
  const f = userscriptFixture();
  const changed = (key: string, value: string) => {
    const url = new URL(startUrl);
    url.searchParams.set(key, value);
    return url.href;
  };
  const invalidUrls = [
    startUrl.replace("my.greenhouse.io", "example.com"),
    startUrl.replace("https:", "http:"),
    startUrl.replace("/jobs/search", "/applications"),
    `${startUrl}&unknown=1`,
    `${startUrl}#fragment`,
    startUrl.replace("https://", "https://user:pass@"),
    `${startUrl}&query=duplicate`,
    `${startUrl}&page=2`,
    changed("query", ""),
    changed("query", "x".repeat(101)),
    changed("query", "bad\nterm"),
    changed("date_posted", "anytime"),
    changed("work_type[]", "hybrid"),
    changed("employment_type[]", "unknown"),
    `${startUrl}&employment_type[]=contract`,
    `${startUrl}&work_type[]=remote`,
    ...["0", "-1", "01", "1.5", "9007199254740992"].map((value) =>
      changed("page", value),
    ),
  ];
  try {
    for (const url of invalidUrls) {
      f.send({ nonce, url });
      await f.run();
    }
    for (const payload of [
      "{",
      "null",
      [],
      { nonce: "wrong-123456", url: startUrl },
      { nonce, url: startUrl, extra: 1 },
      { nonce, url: 42 },
    ]) {
      f.send(payload);
      await f.run();
    }
    assert.deepEqual(f.calls, []);
    assert.equal(f.error(), null);
    assert.equal(f.input()!.value, "");
  } finally {
    f.close();
  }
});

test("concurrent commands are ignored rather than queued or sent twice by input/change events", async () => {
  let finish!: (reply: Reply) => void;
  const f = userscriptFixture({
    reply: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    f.send({ nonce, url: startUrl });
    await f.flush();
    f.send({ nonce, url: searchUrl("backend", 2) });
    await f.flush();
    assert.equal(f.calls.length, 1);
    finish({ status: 200, json: async () => pageData(1) });
    await f.run();
    assert.equal(f.calls.length, 1);
    assert.equal(f.input()!.value, "");
  } finally {
    f.close();
  }
});

test("non-200 including 409, network failure and unparsable bodies mark errors until the next valid command", async () => {
  const failures: Options["reply"][] = [
    async () => ({ status: 409, json: async () => ({}) }),
    async () => ({ status: 429, json: async () => ({}) }),
    async () => ({ status: 503, json: async () => ({}) }),
    async () => {
      throw Error("network failed");
    },
    async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("truncated");
      },
    }),
  ];
  for (const failure of failures) {
    let fail = true;
    const f = userscriptFixture({
      reply: (page, signal) =>
        fail
          ? failure!(page, signal)
          : Promise.resolve({ status: 200, json: async () => pageData(page) }),
    });
    try {
      f.send({ nonce, url: startUrl });
      await f.run();
      assert.equal(f.error(), nonce);
      assert.equal(f.input()!.value, "");
      assert.equal(f.calls.length, 1);
      fail = false;
      f.send({ nonce, url: searchUrl("backend", 2) });
      await f.run();
      assert.equal(f.error(), null);
      assert.equal(f.calls.length, 2);
    } finally {
      f.close();
    }
  }
});

test("visible notifications mark errors while hidden and 1x1 screen-reader regions do not", async () => {
  for (const visibility of ["visible", "hidden", "screen-reader"]) {
    const f = userscriptFixture();
    try {
      const notice = f.window.document.createElement("div");
      notice.setAttribute("role", "status");
      notice.textContent = "Something went wrong";
      notice.hidden = visibility === "hidden";
      if (visibility === "screen-reader") notice.dataset.screenReader = "true";
      f.window.document.body.append(notice);
      f.send({ nonce, url: startUrl });
      await f.run();
      notice.remove();
      assert.equal(f.error(), visibility === "visible" ? nonce : null);
      assert.equal(f.calls.length, visibility === "visible" ? 0 : 1);
    } finally {
      f.close();
    }
  }
});

test("page navigation aborts an in-flight command and removes the input without another GET", async () => {
  let signal: AbortSignal | undefined;
  const f = userscriptFixture({
    reply: async (_page, current) => {
      signal = current;
      return new Promise((_resolve, reject) =>
        current.addEventListener("abort", () => reject(Error("aborted"))),
      );
    },
  });
  try {
    f.send({ nonce, url: startUrl });
    await f.flush();
    f.window.history.replaceState(null, "", startUrl);
    f.window.dispatchEvent(new f.window.Event("hashchange"));
    await f.flush();
    assert.equal(signal?.aborted, true);
    assert.equal(f.input(), null);
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
