import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { fixture, advanceUntil } from "./fixtures/greenhouse-pull-fixture.js";
import { activeFormCheckPass } from "../server/autofill/form-checks.js";

/** Runs one pull to its first published Opening and returns the checks it queued. */
async function publishedChecks(setting: boolean | undefined) {
  const f = fixture();
  try {
    if (setting !== undefined)
      f.store.put("settings", "main", {
        ...f.store.settings(),
        greenhouseFormCheckNewOpenings: setting,
      });
    f.manager.start(1, "click");
    await advanceUntil(f, () =>
      f.store.list("task").some((task) => task.status === "running"),
    );
    f.finish();
    await f.manager.tick();
    const [openingId] = f.manager.state()!.addedOpeningIds;
    assert.ok(openingId, "the pull published a new Opening");
    for (let i = 0; i < 100 && activeFormCheckPass(f.store); i++)
      await pause(20);
    return {
      openingId,
      checks: f.store.list("opening_form_check").map((c) => c.openingId),
    };
  } finally {
    await f.close();
  }
}

test("a pull enqueues a form check for the Opening it publishes when the setting is absent or true", async () => {
  for (const setting of [undefined, true]) {
    const { openingId, checks } = await publishedChecks(setting);
    assert.deepEqual(checks, [openingId], `setting ${String(setting)}`);
  }
});

test("a pull queues no form check when the setting is off", async () => {
  const { checks } = await publishedChecks(false);
  assert.deepEqual(checks, []);
});
