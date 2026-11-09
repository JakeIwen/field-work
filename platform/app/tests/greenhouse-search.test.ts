import test from "node:test";
import assert from "node:assert/strict";
import {
  GreenhouseLimit,
  LiveGreenhouseSource,
  searchUrl,
} from "../server/greenhouse-source.js";
import {
  GreenhouseSearchTransient,
  parseGreenhouseResponse,
} from "../server/greenhouse-search.js";

function payload(query = "software", page = 2) {
  return {
    component: "jobs",
    url: searchUrl(query, page),
    props: {
      page,
      moreResultsAvailable: false,
      jobPosts: [
        {
          id: 123,
          urlToken: "example",
          title: "Engineer",
          companyName: "Example",
          publicUrl: "https://job-boards.greenhouse.io/example/jobs/123",
        },
      ],
      currentUserEmail: "account-data-must-not-be-retained@example.com",
    },
  };
}

test("search accepts JSON and full-navigation HTML with identical strict page checks", () => {
  const body = JSON.stringify(payload());
  const html = `<html><body><div id="app" data-page="${body.replaceAll('"', "&quot;")}"></div></body></html>`;
  for (const text of [body, html]) {
    const result = parseGreenhouseResponse({ body: text }, "software", 2);
    assert.ok(result);
    assert.equal(result.cards[0].id, "123");
    assert.equal(result.more, false);
    assert.ok(!JSON.stringify(result).includes("account-data"));
    assert.throws(
      () => parseGreenhouseResponse({ body: text }, "software", 3),
      /requested results/,
    );
  }
  assert.throws(
    () =>
      parseGreenhouseResponse(
        {
          body: JSON.stringify({ ...payload(), url: searchUrl("software", 1) }),
        },
        "software",
        2,
      ),
    /filters changed/,
  );
  assert.throws(
    () =>
      parseGreenhouseResponse(
        { body: JSON.stringify({ ...payload(), component: "login" }) },
        "software",
        2,
      ),
    /requested results/,
  );
});

test("capture failures describe their cause and malformed schemas are not transient", () => {
  for (const response of [
    { body: "" },
    { body: "{broken" },
    { body: "{}", bodyTruncated: true },
    { bodyError: "resource no longer available" },
  ])
    assert.throws(
      () => parseGreenhouseResponse(response, "software", 2),
      GreenhouseSearchTransient,
    );
  assert.throws(
    () =>
      parseGreenhouseResponse(
        { bodyError: "resource no longer available" },
        "software",
        2,
      ),
    /page 2: response body unavailable: resource no longer available/,
  );
  assert.throws(
    () =>
      parseGreenhouseResponse(
        {
          body: JSON.stringify({
            ...payload(),
            props: { ...payload().props, moreResultsAvailable: undefined },
          }),
        },
        "software",
        2,
      ),
    (error: unknown) =>
      error instanceof Error && !(error instanceof GreenhouseSearchTransient),
  );
});

test("deferred Inertia pages keep discovery pending until actual results arrive", () => {
  const shell = {
    ...payload(),
    props: {},
    deferredProps: { jobPosts: ["page", "moreResultsAvailable", "jobPosts"] },
  };
  assert.equal(
    parseGreenhouseResponse({ body: JSON.stringify(shell) }, "software", 2),
    undefined,
  );
  assert.throws(
    () =>
      parseGreenhouseResponse(
        { body: JSON.stringify({ ...shell, url: searchUrl("software", 1) }) },
        "software",
        2,
      ),
    /filters changed/,
  );
  assert.equal(
    parseGreenhouseResponse({ body: JSON.stringify(payload()) }, "software", 2)!
      .cards.length,
    1,
  );
});

function sourceFixture(
  options: {
    body?: string;
    bodyError?: string;
    status?: number;
    notice?: string;
    domUrl?: string;
  } = {},
) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  const url = searchUrl("software", 2);
  const fetcher: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ route, body });
    let data: unknown = {};
    if (route === "/tabs") data = { tabId: "owned" };
    else if (route === "/tab/owned") data = { url };
    else if (route.endsWith("/dom"))
      data = {
        url: options.domUrl ?? url,
        html: `<body>${options.notice ?? ""}</body>`,
      };
    else if (route.endsWith("/network_requests"))
      data =
        body.since === undefined
          ? { cursor: 12 }
          : {
              requests: [
                {
                  url,
                  requestId: "request",
                  status: options.status ?? 200,
                  mimeType: "text/html",
                },
              ],
            };
    else if (route.endsWith("/network_body"))
      data = {
        body: options.body ?? JSON.stringify(payload()),
        bodyError: options.bodyError,
        responseHeaders: { "Retry-After": "300" },
      };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return { calls, source: new LiveGreenhouseSource(undefined, fetcher) };
}

test("live source captures HTML responses through its owned tab and requests a bounded body", async () => {
  const f = sourceFixture({
    body: `<div data-page="${JSON.stringify(payload()).replaceAll('"', "&quot;")}"></div>`,
  });
  const page = await f.source.page("software", 2);
  assert.equal(page.cards.length, 1);
  assert.equal(
    f.calls.find((c) => c.route.endsWith("/network_body"))!.body.maxBytes,
    1024 * 1024,
  );
  assert.equal(f.calls.filter((c) => c.route.endsWith("/reload")).length, 1);
  await f.source.close();
});

test("live source distinguishes rate limits, transient bodies, server failures and sign-in", async () => {
  for (const [options, expected] of [
    [{ status: 429 }, GreenhouseLimit],
    [{ notice: "API limit reached" }, GreenhouseLimit],
    [{ status: 503 }, GreenhouseSearchTransient],
    [{ bodyError: "not yet available" }, GreenhouseSearchTransient],
  ] as const) {
    const f = sourceFixture(options);
    await assert.rejects(f.source.page("software", 2), expected);
    await f.source.close();
  }
  const login = sourceFixture({
    domUrl: "https://my.greenhouse.io/users/sign_in",
  });
  await assert.rejects(
    login.source.page("software", 2),
    (error: unknown) =>
      error instanceof Error &&
      /Sign in/.test(error.message) &&
      !(error instanceof GreenhouseSearchTransient),
  );
  await login.source.close();
});

test("partial responses require a matching captured URL and never override conflicting response identity", () => {
  const payload = {
    component: "jobs",
    props: { page: 2, moreResultsAvailable: false, jobPosts: [] },
  };
  const parse = (requestUrl?: string, url?: string | null) =>
    parseGreenhouseResponse(
      { body: JSON.stringify({ ...payload, url }) },
      "software engineer",
      2,
      ["contract"],
      requestUrl,
    );
  const url = searchUrl("software engineer", 2, ["contract"]);
  assert.equal(parse(url)!.more, false);
  for (const bad of [
    undefined,
    searchUrl("software engineer", 2),
    searchUrl("software engineer", 1, ["contract"]),
    searchUrl("backend", 2, ["contract"]),
    url.replace("remote", "hybrid"),
    url.replace("past_ten_days", "anytime"),
    url.replace("my.greenhouse.io", "example.com"),
    `${url}&employment_type[]=temporary`,
  ]) {
    assert.throws(() => parse(bad), /filters changed/);
  }
  assert.throws(
    () => parse(url, searchUrl("software engineer", 2)),
    /filters changed/,
  );
  assert.throws(
    () => parse(searchUrl("software engineer", 2), url),
    /filters changed/,
  );
  assert.throws(() => parse(url, null), /filters changed/);
  const combined = new URL(searchUrl("software engineer", 2));
  combined.searchParams.set(
    "employment_type[]",
    combined.searchParams.getAll("employment_type[]").sort().join(","),
  );
  assert.throws(
    () =>
      parseGreenhouseResponse(
        { body: JSON.stringify(payload) },
        "software engineer",
        2,
        undefined,
        combined.href,
      ),
    /filters changed/,
  );
});
