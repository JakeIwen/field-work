import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Records } from "../server/records.js";
import { Store, sha256 } from "../server/storage.js";
import { ResumableJob } from "../server/resumable-job.js";
import { CareersScanManager } from "../server/careers/scans.js";
import { OpeningValidationManager } from "../server/opening-validation.js";
import { defaultFitCriteria } from "../shared/fit-criteria.js";

type ValidationRun = Records["opening_validation_run"];

class TestJob extends ResumableJob<"opening_validation_run"> {
  constructor(store: Store, notify: () => void) {
    super(store, notify, "opening_validation_run");
  }
  save(run: ValidationRun, id?: string) {
    return this.saveRun(run, id);
  }
  launch(
    id: string,
    worker: (signal: AbortSignal) => Promise<unknown>,
    onFailure: (error: Error, signal: AbortSignal) => unknown,
    afterLaunch?: () => void,
    afterSettled?: () => void,
  ) {
    this.launchRun(id, worker, onFailure, afterLaunch, afterSettled);
  }
  async wait() {
    await this.running;
  }
  get currentId() {
    return this.activeId;
  }
}

class BlankError extends Error {
  override toString() {
    return "fallback error";
  }
}

function validationRun(id: string, status = "running"): ValidationRun {
  return {
    id,
    status,
    startedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    total: 0,
    completed: 0,
    counts: { open: 0, closed: 0, unknown: 0 },
    targets: [],
    results: [],
  };
}

function careerRun(id: string): Records["career_scan"] {
  return {
    id,
    requestId: id,
    mode: "all",
    status: "running",
    startedAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    companies: [],
    sourceHashes: {},
    rows: [],
    poolHash: "pool",
    completed: 0,
    total: 0,
    fitCriteria: defaultFitCriteria,
  };
}

async function fixture(fn: (store: Store) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "resumable-job-"));
  const store = new Store(root, path.join(root, "data"));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("base save and launch preserve persistence and notification order", async () =>
  fixture(async (store) => {
    const events: string[] = [];
    store.autoExport = () => {
      events.push(
        `export:${store.get("opening_validation_run", "run")?.status}`,
      );
    };
    const job = new TestJob(store, () => {
      events.push(
        `notify:${store.get("opening_validation_run", "run")?.status}`,
      );
    });
    const saved = job.save(validationRun("run"));
    assert.notEqual(saved.updatedAt, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(events, ["export:running", "notify:running"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    job.launch(
      "run",
      async () => {
        events.push("worker");
        await gate;
      },
      () => events.push("failure"),
      () => events.push("launch-notify"),
      () => events.push("settled-notify"),
    );
    assert.equal(job.active, true);
    assert.equal(job.currentId, "run");
    assert.deepEqual(events.slice(2), ["worker", "launch-notify"]);
    release();
    await job.wait();
    assert.deepEqual(events.slice(2), [
      "worker",
      "launch-notify",
      "settled-notify",
    ]);
    assert.equal(job.active, false);
    assert.equal(job.currentId, null);
  }));

test("base launch leaves manager-specific error serialization unchanged", async () =>
  fixture(async (store) => {
    const job = new TestJob(store, () => {});
    const error = new BlankError("");
    let careers = "unset";
    let validation = "unset";
    job.launch(
      "careers",
      async () => Promise.reject(error),
      (e) => {
        careers = String(e.message || e);
      },
    );
    await job.wait();
    job.launch(
      "validation",
      async () => Promise.reject(error),
      (e) => {
        validation = String(e.message);
      },
    );
    await job.wait();
    assert.equal(careers, "fallback error");
    assert.equal(validation, "");
  }));

test("close aborts the active signal and waits for settlement", async () =>
  fixture(async (store) => {
    const job = new TestJob(store, () => {});
    let failure = "";
    let settled = false;
    job.launch(
      "run",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("worker stopped")),
            { once: true },
          );
        }),
      (error, signal) => {
        failure = `${error.message}:${signal.aborted}`;
      },
      undefined,
      () => {
        settled = true;
      },
    );
    await job.close();
    assert.equal(failure, "worker stopped:true");
    assert.equal(settled, true);
    assert.equal(job.active, false);
  }));

test("base persistence retains an explicit storage key independently of payload id", async () =>
  fixture(async (store) => {
    const job = new TestJob(store, () => {});
    job.save(validationRun("payload-id"), "storage-key");
    assert.equal(
      store.get("opening_validation_run", "storage-key")?.id,
      "payload-id",
    );
    assert.equal(store.get("opening_validation_run", "payload-id"), undefined);
  }));

for (const status of ["running", "pausing"]) {
  test(`restart recovery fails a mismatched ${status} scan at its storage key`, async () =>
    fixture(async (store) => {
      const original = { ...careerRun("payload-id"), status };
      store.put("career_scan", "storage-key", original);
      const matching = {
        ...careerRun("payload-id"),
        status: "completed",
        error: "Leave this separate record unchanged",
      };
      store.put("career_scan", "payload-id", matching);
      const manager = new CareersScanManager(
        store,
        () => {},
        async () => {},
      );
      await manager.close();
      assert.deepEqual(store.get("career_scan", "storage-key"), {
        ...original,
        status: "failed",
        error:
          "Server restarted, but this scan's stored identity does not match its storage key. Recovery was skipped; start a new scan.",
      });
      assert.deepEqual(store.get("career_scan", "payload-id"), matching);
    }));
}

test("corrupt career identities never reach recovery callbacks", async (t) =>
  fixture(async (store) => {
    const callback = t.mock.fn();
    class RecoveryProbe extends ResumableJob<"career_scan"> {
      recover() {
        this.recoverInterruptedRuns({
          eligibleStatuses: ["running", "pausing"],
          before: callback,
          reload: (run) => {
            callback();
            return run;
          },
          interrupt: callback,
        });
      }
    }
    for (const status of ["running", "pausing", "publishing"])
      store.put("career_scan", status, { ...careerRun("corrupt-id"), status });
    const job = new RecoveryProbe(store, () => {}, "career_scan");
    job.recover();
    assert.equal(callback.mock.callCount(), 0);
    assert.ok(
      store.list("career_scan").every((run) => run.status === "failed"),
    );
  }));

test("mismatched publishing recovery fails without using the corrupt payload id for files", async () =>
  fixture(async (store) => {
    store.put("career_scan", "publishing-key", {
      ...careerRun("payload-id"),
      status: "publishing",
    });
    const manager = new CareersScanManager(
      store,
      () => {},
      async () => {},
    );
    await manager.close();
    const recovered = store.get("career_scan", "publishing-key");
    assert.equal(recovered?.id, "payload-id");
    assert.equal(recovered?.status, "failed");
    assert.match(
      recovered?.error ?? "",
      /publication recovery was not attempted/i,
    );
    assert.equal(store.get("career_scan", "payload-id"), undefined);
  }));

test("restart recovery does not write through a deleted payload id", async () =>
  fixture(async (store) => {
    const payloadId = "deleted-payload-id";
    const identityHash = sha256(`career_scan:${payloadId}`);
    store.put("career_scan", "surviving-key", careerRun(payloadId));
    store.put("deleted_record", identityHash, {
      id: identityHash,
      kind: "career_scan",
      identityHash,
      deletedAt: "2000-01-01T00:00:00.000Z",
    });
    const manager = new CareersScanManager(
      store,
      () => {},
      async () => {},
    );
    await manager.close();
    const recovered = store.get("career_scan", "surviving-key");
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /stored identity does not match/);
    assert.equal(store.get("career_scan", payloadId), undefined);
  }));

test("mismatched recovery respects a tombstone at the actual storage key", async (t) =>
  fixture(async (store) => {
    const original = careerRun("payload-id");
    store.put("career_scan", "deleted-key", original);
    const identityHash = sha256("career_scan:deleted-key");
    store.put("deleted_record", identityHash, {
      id: identityHash,
      kind: "career_scan",
      identityHash,
      deletedAt: "2000-01-01T00:00:00.000Z",
    });
    const warnings = t.mock.method(console, "warn", () => {});
    const manager = new CareersScanManager(
      store,
      () => {},
      async () => {},
    );
    await manager.close();
    assert.deepEqual(store.get("career_scan", "deleted-key"), original);
    assert.equal(store.get("career_scan", "payload-id"), undefined);
    assert.match(
      String(warnings.mock.calls[0]?.arguments[0]),
      /deleted.*deleted-key/,
    );
  }));

test("mismatched recovery contains deletion detected by the final write", async (t) =>
  fixture(async (store) => {
    const original = careerRun("payload-id");
    store.put("career_scan", "storage-key", original);
    const isDeleted = store.isDeleted.bind(store);
    let checks = 0;
    t.mock.method(store, "isDeleted", (kind: keyof Records, id: string) => {
      if (kind === "career_scan" && id === "storage-key") return ++checks === 2;
      return isDeleted(kind, id);
    });
    const warnings = t.mock.method(console, "warn", () => {});
    const manager = new CareersScanManager(
      store,
      () => {},
      async () => {},
    );
    await manager.close();
    assert.equal(checks, 2);
    assert.deepEqual(store.get("career_scan", "storage-key"), original);
    assert.match(
      String(warnings.mock.calls[0]?.arguments[0]),
      /deleted career_scan storage-key/,
    );
  }));

test("background settlement contains failure-persistence rejections", async (t) =>
  fixture(async (store) => {
    const errors = t.mock.method(console, "error", () => {});
    const job = new TestJob(store, () => {});
    job.launch(
      "removed",
      async () => {
        throw new Error("record disappeared");
      },
      () => {
        throw new Error("failure persistence rejected");
      },
    );
    await assert.doesNotReject(job.wait());
    assert.equal(job.active, false);
    assert.equal(job.currentId, null);
    assert.match(
      String(errors.mock.calls[0]?.arguments[0]),
      /opening_validation_run removed/,
    );
    assert.match(
      String(errors.mock.calls[0]?.arguments[0]),
      /failure persistence rejected/,
    );
  }));

test("manager restart policies retain their distinct persistence effects", async () =>
  fixture(async (store) => {
    store.put("career_scan", "career", careerRun("career"));
    store.put(
      "opening_validation_run",
      "validation",
      validationRun("validation"),
    );
    const events: string[] = [];
    store.autoExport = () => events.push("export");
    const notify = () => events.push("notify");
    new CareersScanManager(store, notify, async () => {});
    const career = store.get("career_scan", "career")!;
    assert.equal(career.status, "interrupted");
    assert.equal(career.updatedAt, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(events, []);
    new OpeningValidationManager(store, notify);
    const validation = store.get("opening_validation_run", "validation")!;
    assert.equal(validation.status, "interrupted");
    assert.equal(
      validation.error,
      "Server restarted. Resume to check the remaining openings.",
    );
    assert.notEqual(validation.updatedAt, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(events, ["export", "notify"]);
  }));
