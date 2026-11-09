// Run through browser_clean. Gmail reads and writes are intercepted; no mailbox or preferences are changed.
async (page) => {
  const origin = "http://127.0.0.1:4317",
    checks = [],
    errors = [],
    requests = [];
  const assert = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const onError = (error) => errors.push(String(error));
  page.on("pageerror", onError);
  let data = {
    configured: false,
    connected: false,
    checking: false,
    enabled: true,
    autoUpdate: true,
    includeNegative: false,
    needsNegativeBackfill: false,
    hasMore: false,
    checked: 0,
    replies: [],
  };
  const handler = async (route) => {
    const url = {
        pathname: route.request().url().slice(origin.length).split("?")[0],
      },
      body =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : undefined;
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/settings")) data = { ...data, ...body };
    if (url.pathname.endsWith("/review"))
      data = {
        ...data,
        replies: data.replies.map((r) => ({
          ...r,
          reviewedAt: new Date().toISOString(),
        })),
      };
    await route.fulfill({ json: data });
  };
  await page.unroute("**/api/gmail{,/**}");
  await page.route("**/api/gmail{,/**}", handler);
  await page.goto("about:blank");
  await page.goto(origin + "/#replies");
  const oldTheme = await page.evaluate(() =>
    localStorage.getItem("fieldwork.theme"),
  );
  try {
    await page
      .getByText("No completed Gmail check yet.", { exact: true })
      .waitFor();
    assert(
      (await page.getByLabel("Google Desktop OAuth client JSON").count()) === 1,
      "Setup upload missing",
    );
    assert(
      requests.filter(
        (r) => r.path === "/api/gmail/check" && r.body?.manual === false,
      ).length === 1,
      "Initial load did not trigger one automatic check: " +
        JSON.stringify(requests),
    );
    await page
      .getByRole("link", { name: "Openings", exact: false })
      .first()
      .click();
    await page
      .getByRole("link", { name: "Employer replies", exact: true })
      .click();
    assert(
      requests.filter((r) => r.path === "/api/gmail/check").length === 1,
      "Route navigation repeated startup check",
    );
    checks.push(
      "Disconnected setup; one automatic check per app load, no extra check on navigation",
    );
    const state = await page.evaluate(
      async () => await (await fetch("/api/state")).json(),
    );
    const app = state.applications[0];
    assert(app, "An application fixture link is required");
    data = {
      ...data,
      configured: true,
      connected: true,
      account: "fixture@example.net",
      lastCheckedAt: new Date().toISOString(),
      replies: [
        {
          id: "fixture",
          messageId: "abcd1234",
          account: "fixture@example.net",
          threadId: "abcd1234",
          sender: "Recruiter <hr@example.net>",
          subject: "Fixture interview invitation",
          receivedAt: new Date().toISOString(),
          excerpt: "Please share your availability. <script>fixture()</script>",
          kind: "interview",
          applicationIds: [app.id],
          reason: "Fixture unique company and role match.",
          detectedAt: new Date().toISOString(),
          update: {
            applicationId: app.id,
            from: "applied",
            to: "interviewing",
            at: new Date().toISOString(),
          },
        },
      ],
    };
    const colors = [];
    for (const theme of ["soft", "dark"]) {
      await page.evaluate(
        (theme) => localStorage.setItem("fieldwork.theme", theme),
        theme,
      );
      await page.reload();
      await page
        .getByText("Fixture interview invitation", { exact: true })
        .waitFor();
      assert(
        (await page
          .getByText("Application moved from applied to interviewing.", {
            exact: true,
          })
          .count()) === 1,
        "Status update evidence missing",
      );
      assert(
        (await page
          .getByRole("link", { name: "Open in Gmail", exact: true })
          .getAttribute("href")) ===
          "https://mail.google.com/mail/u/?authuser=fixture%40example.net#all/abcd1234",
        "Gmail link lost account or message identity",
      );
      assert(
        (await page.locator(".gmail-excerpt script").count()) === 0,
        "Email excerpt rendered as HTML",
      );
      const link = page.locator('.gmail-reply a[href^="#applications/"]');
      const before = page.url();
      await link.evaluate((element) => {
        document.addEventListener("click", (event) => event.preventDefault(), {
          once: true,
        });
        element.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
          }),
        );
      });
      assert(
        page.url() === before,
        "Modified application click changed source tab",
      );
      const color = await page.locator(".gmail-excerpt").evaluate((e) => {
        const s = getComputedStyle(e);
        let parent = e,
          bg = "rgba(0, 0, 0, 0)";
        while (parent && bg === "rgba(0, 0, 0, 0)") {
          bg = getComputedStyle(parent).backgroundColor;
          parent = parent.parentElement;
        }
        // Palette tokens compute to oklch(); report sRGB for the contrast math.
        const srgb = (color) => {
          const context = document.createElement("canvas").getContext("2d");
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return `rgb(${[...context.getImageData(0, 0, 1, 1).data].slice(0, 3).join(", ")})`;
        };
        return { text: srgb(s.color), background: srgb(bg) };
      });
      const lum = (c) =>
        c
          .match(/[0-9.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((n) => n / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
          .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
      const a = lum(color.text),
        b = lum(color.background),
        contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert(contrast >= 4.5, `${theme} excerpt contrast ${contrast}`);
      colors.push(color.background);
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Mobile Gmail panel overflow",
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      checks.push(
        `${theme}: reply evidence, Gmail/application links, escaped excerpt, mobile fit, contrast ${contrast.toFixed(2)}:1`,
      );
    }
    assert(colors[0] !== colors[1], "Reply background did not follow theme");
    await page
      .getByLabel("Automatically update clear application matches")
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector('.gmail-panel input[type="checkbox"]')
          ?.disabled,
    );
    assert(data.autoUpdate === false, "Automatic update switch did not save");
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    assert(
      requests.some(
        (r) => r.path === "/api/gmail/check" && r.body.manual === true,
      ),
      "Manual check did not reach endpoint",
    );
    await page
      .getByRole("button", { name: "Mark reviewed", exact: true })
      .click();
    await page
      .getByText(
        "No detected replies to review. Unusual wording may need a check in Gmail.",
        { exact: true },
      )
      .waitFor();
    await page.getByLabel("Show reviewed replies").check();
    await page
      .getByText("Fixture interview invitation", { exact: true })
      .waitFor();
    checks.push("Manual check, preference save, persistent review visibility");
    data = {
      ...data,
      hasMore: true,
      checked: 100,
      error: "Fixture rate limit",
      retryAt: new Date(Date.now() + 60000).toISOString(),
    };
    await page.reload();
    await page.getByText("Fixture rate limit", { exact: true }).waitFor();
    assert(
      await page
        .getByRole("button", { name: "Continue check", exact: true })
        .isDisabled(),
      "Cooldown did not disable retries",
    );
    checks.push("Incomplete pagination and cooldown are visible");
    assert(errors.length === 0, errors.join("\n"));
    return {
      testedAt: new Date().toISOString(),
      environment: "browser_clean; real Fieldwork UI, fixture Gmail endpoints",
      checks,
      errors,
    };
  } finally {
    await page.unroute("**/api/gmail{,/**}", handler);
    page.off("pageerror", onError);
    await page.evaluate(
      (value) =>
        value === null
          ? localStorage.removeItem("fieldwork.theme")
          : localStorage.setItem("fieldwork.theme", value),
      oldTheme,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + "/#replies");
  }
};
