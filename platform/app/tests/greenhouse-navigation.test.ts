import test from "node:test";
import assert from "node:assert/strict";
import {
  GreenhouseLimit,
  GreenhouseBridgeTransient,
  searchUrl,
} from "../server/greenhouse-source.js";
import { greenhouseDefaultPacingMs } from "../shared/greenhouse-search.js";
import { GreenhouseSearchTransient } from "../server/greenhouse-search.js";
import { greenhouseBrowserFixture } from "./fixtures/greenhouse-browser.js";
import {
  fixture,
  card,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";

const query = "software engineer";
const navigations = (f: ReturnType<typeof greenhouseBrowserFixture>) =>
  f.calls.filter((call) => call.name === "navigate");
function managedBrowser(browser: ReturnType<typeof greenhouseBrowserFixture>) {
  let source = browser.source;
  const live = fixture({
    page: (...args) => source.page(...args),
    close: () => source.close(),
    cancelSearch: () => source.cancelSearch(),
  });
  const run = live.manager.start();
  live.store.put("greenhouse_pull_run", run.id, {
    ...run,
    queryPlan: [
      { query, employmentTypes: ["contract"], page: 1, exhausted: false },
    ],
  });
  return {
    live,
    run,
    replaceSource: () => {
      source = browser.newSource();
    },
  };
}

test("each pull step captures one page, with only the initial page navigating and later pages filled through the command input", async () => {
  const browser = greenhouseBrowserFixture({ userscript: true });
  const { live, run } = managedBrowser(browser);
  try {
    await live.manager.tick();
    assert.deepEqual(
      live.manager.latest()!.pages.map((page) => page.page),
      [1],
    );
    assert.equal(live.store.list("task").length, 0);
    await advanceUntil(live, () => live.manager.latest()!.pages.length === 3);
    const saved = live.manager.latest()!;
    const requests = browser.calls.filter((call) =>
      ["navigate", "fill"].includes(call.name),
    );
    assert.deepEqual(
      requests.map((call) => call.name),
      ["navigate", "fill", "fill"],
    );
    assert.deepEqual(
      requests.map((call) => call.at - requests[0].at),
      [0, 2000, 4000],
    );
    assert.equal(
      String(requests[0].body.url),
      `${searchUrl(query, 1, ["contract"])}#fieldwork-pull=${saved.searchNonce}`,
    );
    assert.deepEqual(
      requests.slice(1).map((call) => call.body),
      [2, 3].map((page) => ({
        selector: "#fieldwork-search-command",
        value: JSON.stringify({
          nonce: saved.searchNonce,
          url: searchUrl(query, page, ["contract"]),
        }),
      })),
    );
    assert.equal(saved.searchTransport, "userscript");
    assert.equal(saved.searchTransportNote, undefined);
    assert.equal(greenhouseDefaultPacingMs, 2000);
    assert.equal(live.manager.ledger(run.id).candidates.length, 3);
  } finally {
    await live.close();
  }
});

test("different search terms, filters and page numbers use the same loaded tab and one GET per fill", async () => {
  const browser = greenhouseBrowserFixture({ userscript: true });
  const options = { nonce: "run-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, ["contract"], options);
    assert.equal(
      (await browser.source.page("backend", 7, ["temporary"], options)).page,
      7,
    );
    assert.equal(
      (await browser.source.page("full stack", 2, undefined, options)).query,
      "full stack",
    );
    assert.equal(navigations(browser).length, 1);
    const fills = browser.calls.filter((call) => call.name === "fill");
    assert.deepEqual(
      fills.map((call) => JSON.parse(String(call.body.value))),
      [
        { nonce: options.nonce, url: searchUrl("backend", 7, ["temporary"]) },
        { nonce: options.nonce, url: searchUrl("full stack", 2) },
      ],
    );
    assert.equal(
      browser.location(),
      `${searchUrl(query, 1, ["contract"])}#fieldwork-pull=${options.nonce}`,
    );
    await browser.source.cancelSearch(options.nonce);
    assert.equal(
      navigations(browser).length,
      1,
      "pause does not issue a fragment navigation",
    );
    const restarted = browser.newSource();
    await restarted.page("frontend", 3, undefined, options);
    assert.equal(
      navigations(browser).length,
      1,
      "a retained owned tab can accept commands after restart",
    );
    await restarted.close();
  } finally {
    await browser.source.close();
  }
});

test("commands still run when Kapture reports the activated tab URL without its fragment", async () => {
  const browser = greenhouseBrowserFixture({
    userscript: true,
    reportFragment: false,
  });
  const options = { nonce: "run-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, ["contract"], options);
    await browser.source.page("backend", 1, ["part_time"], options);
    await browser.source.page("frontend", 2, undefined, options);
    assert.equal(navigations(browser).length, 1);
    assert.equal(
      browser.calls.filter((call) => call.name === "fill").length,
      2,
    );
  } finally {
    await browser.source.close();
  }
});

test("commands continue when Kapture briefly reports a URL the userscript fetched", async () => {
  const browser = greenhouseBrowserFixture({
    userscript: true,
    reportLastRequest: true,
  });
  const options = { nonce: "run-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, ["contract"], options);
    await browser.source.page("frontend", 1, ["part_time"], options);
    await browser.source.page("backend", 1, ["part_time"], options);
    await browser.source.page("full stack", 2, undefined, options);
    assert.equal(navigations(browser).length, 1);
    assert.equal(
      browser.calls.filter((call) => call.name === "fill").length,
      3,
    );
  } finally {
    await browser.source.close();
  }
});

for (const userscript of [true, false])
  test(`a same-page retry stays in the activated tab when Kapture omits the fragment (userscript ${userscript ? "on" : "off"})`, async () => {
    const browser = greenhouseBrowserFixture({
      userscript,
      reportFragment: false,
      behavior: (page, attempt) => (attempt === 1 ? { status: 500 } : {}),
    });
    const options = { nonce: "run-12345678", pacingRate: 2000 };
    try {
      await assert.rejects(
        browser.source.page(query, 1, ["contract"], options),
      );
      const retried = await browser.source.page(
        query,
        1,
        ["contract"],
        options,
      );
      assert.equal(retried.page, 1);
      // No replacement tab: the retry uses the activated document (in-page GET
      // with the userscript, otherwise a reload of the same URL).
      assert.equal(
        browser.calls.filter((call) => call.name === "tabs").length,
        1,
      );
    } finally {
      await browser.source.close();
    }
  });

test("an observed command request keeps the response window beyond userscript detection", async () => {
  const browser = greenhouseBrowserFixture({
    userscript: true,
    behavior: (page) => (page === 2 ? { pendingPolls: 8 } : {}),
  });
  const options = { nonce: "pending-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, undefined, options);
    const result = await browser.source.page("backend", 2, undefined, options);
    assert.equal(result.page, 2);
    assert.equal(navigations(browser).length, 1);
    assert.equal(
      browser.calls.filter((call) => call.name === "fill").length,
      1,
    );
    assert.ok(browser.time() - navigations(browser)[0].at >= 10000);
  } finally {
    await browser.source.close();
  }
});

test("screen-reader live-region markup does not turn command focus into a rate error", async () => {
  for (const noticeHtml of [
    '<span role="status" style="width:1px;height:1px">Option selected</span>',
    '<span aria-live="polite" class="css-react-a11yText">Option selected</span>',
  ]) {
    const browser = greenhouseBrowserFixture({
      userscript: true,
      behavior: () => ({ noticeHtml }),
    });
    const options = { nonce: "screen-reader-1234", pacingRate: 2000 };
    try {
      await browser.source.page(query, 1, undefined, options);
      assert.equal(
        (await browser.source.page("backend", 2, undefined, options)).page,
        2,
      );
      assert.equal(navigations(browser).length, 1);
    } finally {
      await browser.source.close();
    }
  }
});

test("a missing-input 404 falls back without treating the owned tab as missing", async () => {
  const browser = greenhouseBrowserFixture({
    userscript: true,
    bridgeFailure: (command) =>
      command === "fill"
        ? new Response(JSON.stringify({ error: "Element not found" }), {
            status: 404,
          })
        : undefined,
  });
  const options = { nonce: "missing-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, undefined, options);
    assert.equal(
      (await browser.source.page("backend", 2, undefined, options)).page,
      2,
    );
    assert.equal(navigations(browser).length, 2);
    assert.equal(
      browser.calls.filter((call) => call.name === "tabs").length,
      1,
    );
  } finally {
    await browser.source.close();
  }
});

test("missing input, failed fill or no matching request fall back to activated URL navigation", async () => {
  for (const setup of [
    { userscript: false },
    { userscript: true, fillNoRequest: true },
    {
      userscript: true,
      bridgeFailure: (command: string) =>
        command === "fill"
          ? new Response(
              JSON.stringify({
                success: false,
                error: "Element cannot be filled",
              }),
            )
          : undefined,
    },
  ]) {
    const browser = greenhouseBrowserFixture(setup);
    const { live } = managedBrowser(browser);
    try {
      await advanceUntil(live, () => live.manager.latest()!.pages.length === 2);
      assert.equal(navigations(browser).length, 2);
      assert.equal(
        browser.calls.filter((call) => call.name === "fill").length,
        1,
      );
      if (setup.fillNoRequest)
        assert.ok(
          navigations(browser)[1].at - navigations(browser)[0].at >= 7000,
        );
      assert.equal(live.manager.state()!.searchTransport, "navigation");
      assert.match(
        live.manager.state()!.searchTransportNote!,
        /userscript not detected/,
      );
      assert.equal(live.manager.latest()!.failures.length, 0);
      assert.ok(
        navigations(browser).every((call) =>
          new URL(String(call.body.url)).hash.startsWith("#fieldwork-pull="),
        ),
      );
    } finally {
      await live.close();
    }
  }
});

test("replaced pages recover without fragment-only navigate, including a new nonce for the same initial search", async () => {
  const browser = greenhouseBrowserFixture({ userscript: true });
  const options = { nonce: "first-12345678", pacingRate: 2000 };
  try {
    await browser.source.page(query, 1, ["contract"], options);
    browser.replacePage();
    await browser.source.page(query, 1, ["contract"], options);
    assert.equal(
      browser.calls.filter((call) => call.name === "reload").length,
      1,
    );
    await browser.source.page(query, 1, ["contract"], {
      ...options,
      nonce: "second-12345678",
    });
    assert.equal(
      browser.calls.filter((call) => call.name === "tabs").length,
      2,
    );
    assert.equal(navigations(browser).length, 2);
  } finally {
    await browser.source.close();
  }
});

test("pause during a command retains its unrecorded cursor and resumes without reloading", async () => {
  let pause = () => {};
  const browser = greenhouseBrowserFixture({
    userscript: true,
    behavior: (page, attempt) => {
      if (page === 2 && attempt === 1) pause();
      return {};
    },
  });
  const { live, run } = managedBrowser(browser);
  pause = () => {
    live.manager.action(run.id, "pause");
  };
  try {
    await advanceUntil(live, () => live.manager.latest()!.status === "paused");
    assert.deepEqual(
      live.manager.latest()!.pages.map((page) => page.page),
      [1],
    );
    live.manager.action(run.id, "resume");
    await advanceUntil(live, () => live.manager.latest()!.pages.length === 2);
    assert.equal(live.manager.latest()!.failures.length, 0);
    assert.equal(navigations(browser).length, 1);
  } finally {
    await live.close();
  }
});

test("409, other non-200 and notice errors persist cooldown and increased pacing for the exact pending command", async () => {
  for (const behavior of [
    { status: 409, driverError: true },
    { status: 429, driverError: true },
    { status: 400 },
    { noticeHtml: '<div class="snackbar">Something went wrong</div>' },
  ]) {
    const browser = greenhouseBrowserFixture({
      userscript: true,
      behavior: (page, attempt) =>
        page === 2 && attempt === 1 ? behavior : {},
    });
    const { live } = managedBrowser(browser);
    try {
      await advanceUntil(
        live,
        () => live.manager.latest()!.status === "cooldown",
      );
      const saved = live.manager.latest()!;
      assert.equal(saved.page, 2);
      assert.equal(saved.pacingRate, 3000);
      assert.equal(live.store.settings().greenhousePacingRate, undefined);
      assert.equal(live.store.settings().greenhousePacingPenaltyMs, 1000);
      assert.deepEqual(
        saved.pages.map((page) => page.page),
        [1],
      );
      assert.ok(
        Date.parse(saved.retryAt!) >= Date.parse(saved.updatedAt) + 120000,
      );
      if (behavior.status === 429)
        assert.ok(Date.parse(saved.retryAt!) >= browser.time() + 300000);
      if (behavior.status === 409) assert.match(saved.error!, /HTTP 409/);
      live.setTime(Date.parse(saved.retryAt!));
      browser.setTime(Date.parse(saved.retryAt!));
      await advanceUntil(live, () => live.manager.latest()!.pages.length === 2);
      assert.deepEqual(
        live.manager.latest()!.pages.map((page) => page.page),
        [1, 2],
      );
      assert.equal(
        navigations(browser).length,
        behavior.status === 409 ? 2 : 1,
      );
    } finally {
      await live.close();
    }
  }
});

test("a bridge failure during fill is retried as a bridge failure, never a navigation fallback or a rate increase", async () => {
  const browser = greenhouseBrowserFixture({
    userscript: true,
    bridgeFailure: (command) =>
      command === "fill"
        ? new Response("unavailable", { status: 503 })
        : undefined,
  });
  const { live } = managedBrowser(browser);
  try {
    await advanceUntil(
      live,
      () => live.manager.latest()!.status === "cooldown",
    );
    assert.equal(live.manager.latest()!.bridgeFailureCount, 1);
    assert.equal(live.manager.latest()!.pacingRate, 2000);
    assert.equal(live.manager.latest()!.limitCount, 0);
    assert.equal(navigations(browser).length, 1);
    await assert.rejects(
      browser.source.page(query, 2, ["contract"], {
        nonce: live.manager.latest()!.searchNonce!,
        pacingRate: 2000,
      }),
      GreenhouseBridgeTransient,
    );
  } finally {
    await live.close();
  }
});

test("navigation HTML shells wait for deferred JSON and check notices each second", async () => {
  const f = greenhouseBrowserFixture({
    behavior: () => ({ responseAfterPolls: 3 }),
  });
  const result = await f.source.page(query, 1, ["contract"]);
  assert.equal(result.cards[0].id, "1");
  assert.equal(result.more, true);
  const reads = f.calls.filter((call) => call.name === "dom");
  assert.deepEqual(
    reads.map((call) => call.at - reads[0].at),
    [0, 1000, 2000, 3000],
  );
  assert.equal(navigations(f).length, 1);
  await f.source.close();
});

test("limits in API requests from MyGreenhouse count, unrelated hosts and ordinary page text do not", async () => {
  for (const url of [
    "https://my.greenhouse.io/api/search",
    "https://unrelated.example/api",
  ]) {
    const f = greenhouseBrowserFixture({ behavior: () => ({ extra429: url }) });
    if (url.includes("my.greenhouse.io"))
      await assert.rejects(f.source.page(query, 1), GreenhouseLimit);
    else assert.equal((await f.source.page(query, 1)).cards.length, 1);
    await f.source.close();
  }
  const ordinary = greenhouseBrowserFixture({
    behavior: () => ({
      noticeHtml: "<div>Job saved</div>",
    }),
  });
  assert.equal((await ordinary.source.page(query, 1)).cards.length, 1);
  await ordinary.source.close();
});

test("limit wording is detected in transient alert/status/live and toast-like containers", async () => {
  for (const attribute of [
    'role="alert"',
    'role="status"',
    'aria-live="polite"',
    'class="toast"',
    'class="Notification"',
    'class="snackbar"',
  ]) {
    const f = greenhouseBrowserFixture({
      behavior: () => ({
        noticeHtml: `<div ${attribute}>API rate-limit exceeded</div>`,
        responseAfterPolls: 4,
        noticeAtPoll: 2,
      }),
    });
    await assert.rejects(f.source.page(query, 1), GreenhouseLimit);
    const reads = f.calls.filter((call) => call.name === "dom");
    assert.equal(reads.length, 2);
    assert.equal(reads[1].at - reads[0].at, 1000);
    await f.source.close();
  }
});

test("missing requests, incomplete shells, failed requests and server failures are transient, not terminal coverage", async () => {
  for (const behavior of [
    { noRequest: true },
    { responseAfterPolls: 100 },
    { status: 503 },
    { failed: true },
    { bodyError: "resource unavailable" },
  ]) {
    const f = greenhouseBrowserFixture({ behavior: () => behavior });
    await assert.rejects(f.source.page(query, 2), GreenhouseSearchTransient);
    assert.equal(navigations(f).length, 1);
    await f.source.close();
  }
});

test("sign-in redirects stop; missing tabs are replaced without touching unrelated tabs", async () => {
  const signin = greenhouseBrowserFixture({
    behavior: () => ({ signin: true }),
  });
  await assert.rejects(signin.source.page(query, 1), /Sign in/);
  await signin.source.close();
  const f = greenhouseBrowserFixture();
  await f.source.page(query, 1);
  f.removeTab();
  await f.source.page(query, 2);
  f.navigateAway("https://example.com/private");
  await f.source.page(query, 3);
  assert.equal(f.calls.filter((call) => call.name === "tabs").length, 3);
  assert.equal(navigations(f).length, 3);
  await f.source.close();
});

test("public API reads keep independent one-second pacing and rate-limit handling", async () => {
  const f = greenhouseBrowserFixture();
  await f.source.page(query, 1);
  assert.equal((await f.source.posting(card("1")))!.text, "Build software");
  await f.source.page(query, 2);
  await f.source.posting(card("2"));
  await f.source.page(query, 3);
  const requests = f.calls.filter((call) =>
    ["public", "navigate"].includes(call.name),
  );
  assert.deepEqual(
    requests.map((call) => [call.name, call.at - requests[0].at]),
    [
      ["navigate", 0],
      ["public", 0],
      ["public", 1000],
      ["navigate", 2000],
      ["public", 2000],
      ["navigate", 4000],
    ],
  );
  await f.source.close();
  const limited = greenhouseBrowserFixture({ publicStatus: 429 });
  await assert.rejects(
    limited.source.posting(card("1")),
    (error: unknown) =>
      error instanceof GreenhouseLimit &&
      Date.parse(error.retryAt) === limited.time() + 300000,
  );
  await limited.source.close();
});
