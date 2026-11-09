// Run through browser_clean; Gmail settings, replies and application state are fixtures.
async (page) => {
  const origin = "http://127.0.0.1:4317",
    checks = [],
    errors = [],
    writes = [];
  const assert = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const onError = (error) => errors.push(String(error));
  page.on("pageerror", onError);
  await page.goto(origin + "/#replies");
  const original = await page.evaluate(() => ({
    theme: localStorage.getItem("fieldwork.theme"),
    stage: localStorage.getItem("fieldwork.applications.stage"),
    view: localStorage.getItem("fieldwork.applications.view"),
  }));
  const state = await page.evaluate(
    async () => await (await fetch("/api/state")).json(),
  );
  assert(state.applications.length > 0, "Application fixture source required");
  const application = {
    ...state.applications[0],
    id: "gmail-rejected-fixture",
    status: "rejected",
  };
  state.applications = [
    application,
    { ...application, id: "gmail-active-fixture", status: "applied" },
  ];
  const reply = {
    id: "negative-fixture",
    messageId: "abcd1234",
    account: "fixture@example.net",
    threadId: "abcd1234",
    sender: "Recruiter <hr@example.net>",
    subject: "Fixture rejection",
    receivedAt: new Date().toISOString(),
    excerpt:
      "Unfortunately, we will not be moving forward with your application.",
    kind: "rejection",
    applicationIds: [application.id],
    reason: "Fixture unique role and company match.",
    detectedAt: new Date().toISOString(),
    update: {
      applicationId: application.id,
      from: "applied",
      to: "rejected",
      at: new Date().toISOString(),
    },
  };
  let gmail = {
    configured: true,
    connected: true,
    account: "fixture@example.net",
    checking: false,
    enabled: true,
    autoUpdate: true,
    includeNegative: false,
    needsNegativeBackfill: false,
    hasMore: false,
    checked: 0,
    lastCheckedAt: new Date().toISOString(),
    replies: [],
  };
  const mailRoute = async (route) => {
    const path = route.request().url().slice(origin.length).split("?")[0];
    if (path.endsWith("/settings")) {
      const body = route.request().postDataJSON();
      writes.push(body);
      gmail = {
        ...gmail,
        ...body,
        needsNegativeBackfill: body.includeNegative ?? gmail.includeNegative,
      };
    }
    await route.fulfill({
      json: { ...gmail, replies: gmail.includeNegative ? [reply] : [] },
    });
  };
  const stateRoute = (route) => route.fulfill({ json: state });
  await page.route("**/api/gmail{,/**}", mailRoute);
  await page.route("**/api/state", stateRoute);
  try {
    for (const theme of ["soft", "dark"]) {
      gmail = {
        ...gmail,
        includeNegative: false,
        needsNegativeBackfill: false,
      };
      await page.evaluate((theme) => {
        localStorage.setItem("fieldwork.theme", theme);
        localStorage.removeItem("fieldwork.applications.stage");
        localStorage.setItem("fieldwork.applications.view", "list");
      }, theme);
      await page.goto(origin + "/#replies");
      await page.reload();
      const include = page.getByLabel("Include negative replies", {
        exact: true,
      });
      await include.waitFor();
      assert(!(await include.isChecked()), "Negative replies should start off");
      await include.click();
      await page.getByText("Fixture rejection", { exact: true }).waitFor();
      assert(
        writes.at(-1).includeNegative === true,
        "Negative preference not persisted",
      );
      await page
        .getByText("Application moved from applied to rejected.", {
          exact: true,
        })
        .waitFor();
      await page
        .getByText(
          "The next check will also look for negative replies from the past 90 days. Choose Check now to start.",
          { exact: true },
        )
        .waitFor();
      const link = page.locator(
        '.gmail-reply a[href="#applications/gmail-rejected-fixture"]',
      );
      assert(
        (await link.count()) === 1,
        "Rejected application link unavailable",
      );
      await link.click();
      await page.locator(".detail-panel").waitFor();
      assert(
        page.url().endsWith("#applications/gmail-rejected-fixture"),
        "Reply link did not open hidden application",
      );
      assert(
        (await page.locator(".detail-panel").count()) === 1,
        "Hidden application detail unavailable",
      );
      await page.locator('.sidebar a[href="#applications"]').click();
      const stages = page.getByRole("group", {
        name: "Application stage",
        exact: true,
      });
      const rejectedStage = stages.getByRole("button", {
        name: "Rejected 1",
        exact: true,
      });
      const allStages = stages.getByRole("button", {
        name: "All applications 1",
        exact: true,
      });
      await rejectedStage.waitFor();
      const stageLabels = await stages.getByRole("button").allTextContents();
      assert(
        stageLabels.findIndex((label) => label.startsWith("Rejected")) ===
          stageLabels.findIndex((label) => label.startsWith("Interviewing")) +
            1,
        "Rejected selector does not follow Interviewing",
      );
      assert(
        (await page
          .locator('tr[data-application-id="gmail-rejected-fixture"]')
          .count()) === 0,
        "Rejected row is visible by default",
      );
      assert(
        (await page
          .locator('tr[data-application-id="gmail-active-fixture"]')
          .count()) === 1,
        "Active row was hidden",
      );
      await rejectedStage.click();
      await page
        .locator('tr[data-application-id="gmail-rejected-fixture"]')
        .waitFor();
      assert(
        (await page
          .locator('tr[data-application-id="gmail-active-fixture"]')
          .count()) === 0,
        "Rejected stage includes an active application",
      );
      await page.reload();
      await page
        .locator('tr[data-application-id="gmail-rejected-fixture"]')
        .waitFor();
      assert(
        (await rejectedStage.getAttribute("aria-pressed")) === "true",
        "Rejected stage did not survive reload",
      );
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page
        .locator('.kanban a[href="#applications/gmail-rejected-fixture"]')
        .waitFor();
      await allStages.click();
      assert(
        (await page
          .locator('.kanban a[href="#applications/gmail-rejected-fixture"]')
          .count()) === 0,
        "Rejected board card is still visible",
      );
      assert(
        (await page.locator("#kanban-rejected").count()) === 0,
        "Hidden rejected board column remains",
      );
      await page
        .locator('.kanban a[href="#applications/gmail-active-fixture"]')
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Mobile applications overflow",
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(origin + "/#replies");
      await page.getByText("Fixture rejection", { exact: true }).waitFor();
      await page
        .getByLabel("Include negative replies", { exact: true })
        .click();
      await page
        .getByText(
          "No detected replies to review. Unusual wording may need a check in Gmail.",
          { exact: true },
        )
        .waitFor();
      checks.push(
        `${theme}: optional negative replies, backfill explanation, hidden detail links, default list/board hiding and persistent Rejected stage`,
      );
    }
    assert(errors.length === 0, errors.join("\n"));
    return {
      testedAt: new Date().toISOString(),
      environment:
        "browser_clean; fixture Gmail and application state; no live status or preference writes",
      checks,
      errors,
    };
  } finally {
    await page.unroute("**/api/gmail{,/**}", mailRoute);
    await page.unroute("**/api/state", stateRoute);
    page.off("pageerror", onError);
    await page.evaluate((original) => {
      for (const [key, value] of [
        ["fieldwork.theme", original.theme],
        ["fieldwork.applications.stage", original.stage],
        ["fieldwork.applications.view", original.view],
      ])
        value === null
          ? localStorage.removeItem(key)
          : localStorage.setItem(key, value);
    }, original);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + "/#replies");
    await page.reload();
  }
};
