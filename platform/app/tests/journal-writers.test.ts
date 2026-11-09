import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

// The same endpoint receives review markers from opening a detail and deliberate edits.
test("personal updates journal actual edited fields, not review markers or unchanged values", async () => {
  const f = applicationAnswerFixture();
  const opening = f.store.get("cache_opening", "one");
  assert.ok(opening);
  f.store.put("cache_opening", "one", {
    ...opening,
    company_id: "example",
    company: "Example",
    title: "Engineer",
  });
  f.store.close();
  const workspace = await openFixtureWorkspace(f.root);
  try {
    const entries = () =>
      workspace.store
        .list("journal")
        .filter((entry) => entry.type === "personal_updated");
    let response = await workspace.post("/api/personal/one", {
      expectedVersion: 0,
      reviewedHash: "opening",
    });
    assert.equal(response.status, 200);
    assert.equal(
      workspace.store.get("personal", "one")?.reviewedHash,
      "opening",
    );
    assert.deepEqual(entries(), []);
    response = await workspace.post("/api/personal/one", {
      expectedVersion: 1,
      notes: "private notes",
      saved: true,
      reviewedHash: "changed",
    });
    assert.equal(response.status, 200);
    assert.equal(entries().length, 1);
    assert.equal(entries()[0].message, "Updated personal fields: saved, notes");
    assert.deepEqual(entries()[0].details, { fields: ["saved", "notes"] });
    assert.equal(JSON.stringify(entries()).includes("private notes"), false);
    response = await workspace.post("/api/personal/one", {
      expectedVersion: 2,
      notes: "private notes",
      saved: true,
    });
    assert.equal(response.status, 200);
    assert.equal(entries().length, 1);
    response = await workspace.post("/api/personal/one", {
      expectedVersion: 1,
      notes: "stale",
    });
    assert.equal(response.status, 409);
    assert.equal(entries().length, 1);
  } finally {
    await workspace.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
