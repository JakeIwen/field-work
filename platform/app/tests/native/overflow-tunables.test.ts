import test from "node:test";
import assert from "node:assert/strict";
import { overflowPreparationFixture } from "../fixtures/overflow-preparation.js";

const native = { skip: process.platform !== "darwin", timeout: 60000 };

test(
  "overflow recovery honors a live one-attempt shortening limit",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t, 99);
    try {
      f.store.put("settings", "main", {
        ...f.store.settings(),
        tunables: { "autofill.overflowShortenAttempts": 1 },
      });
      f.manager.start("one", "resume");
      for (let i = 0; i < 12; i++) await f.manager.tick();
      assert.equal(f.followups.length, 1);
      assert.equal(f.manager.latest("one")?.status, "failed");
      assert.match(f.manager.latest("one")?.error ?? "", /1 attempts/);
    } finally {
      await f.close();
    }
  },
);
