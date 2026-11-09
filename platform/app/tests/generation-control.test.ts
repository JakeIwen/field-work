import test from "node:test";
import assert from "node:assert/strict";
import {
  abortGenerations,
  assertGenerationActive,
  beginGeneration,
  runGenerationProcess,
} from "../server/generation-control.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";

test("reload cancels owned generation processes, waits for cleanup and rejects new work", async () => {
  const f = applicationAnswerFixture();
  let cleaned = false;
  try {
    const finished = beginGeneration(f.store);
    const work = runGenerationProcess(
      f.store,
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeout: 10000 },
    ).finally(() => {
      cleaned = true;
      finished();
    });
    const rejected = assert.rejects(work, /aborted|interrupted/i);
    await abortGenerations(f.store);
    await rejected;
    assert.equal(cleaned, true);
    assert.throws(() => assertGenerationActive(f.store), /Reload app/);
    await assert.rejects(
      () =>
        runGenerationProcess(
          f.store,
          process.execPath,
          ["-e", "process.exit(0)"],
          {},
        ),
      /Reload app/,
    );
  } finally {
    f.cleanup();
  }
});

test("cancelling one workspace leaves other workspaces usable", async () => {
  const first = applicationAnswerFixture(),
    second = applicationAnswerFixture();
  try {
    await abortGenerations(first.store);
    const result = await runGenerationProcess(
      second.store,
      process.execPath,
      ["-e", "console.log('intact')"],
      {},
    );
    assert.equal(result.stdout.trim(), "intact");
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("an autofill read already in flight cannot publish a script after reload cancellation", async () => {
  const f = applicationAnswerFixture();
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const work = generateAutofill(f.store, "one", async (...args) => {
      await pending;
      return f.read(...args);
    });
    const rejected = assert.rejects(work, /Reload app/);
    const cancelled = abortGenerations(f.store);
    release();
    await Promise.all([cancelled, rejected]);
    assert.equal(f.store.list("application_autofill").length, 0);
  } finally {
    release();
    f.cleanup();
  }
});
