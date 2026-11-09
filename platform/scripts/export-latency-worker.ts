import { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { openFixtureWorkspace } from "../app/tests/fixtures/http-workspace.js";
import type { Store } from "../app/server/storage.js";

export type ExportTiming = {
  snapshotMs: number;
  stringifyMs: number;
  writeMs: number;
  renameMs: number;
  totalMs: number;
  otherMs: number;
  bytes: number;
  peakRssMiB: number;
  serializedBytes: number;
};

function instrumentExports(store: Store) {
  let current: ExportTiming | undefined;
  const timed = <T>(
    phase: "snapshotMs" | "stringifyMs" | "writeMs" | "renameMs",
    action: () => T,
  ): T => {
    if (!current) return action();
    const start = performance.now();
    try {
      return action();
    } finally {
      current[phase] += performance.now() - start;
    }
  };
  // Proxies instrument the actual Store.autoExport path, not a reimplementation.
  store.personalExport = new Proxy(store.personalExport, {
    apply: (target, receiver, args) =>
      timed("snapshotMs", () => Reflect.apply(target, receiver, args)),
  });
  JSON.stringify = new Proxy(JSON.stringify, {
    apply: (target, receiver, args) =>
      timed("stringifyMs", () => {
        const result = Reflect.apply(target, receiver, args);
        if (current && typeof result === "string")
          current.serializedBytes += Buffer.byteLength(result);
        return result;
      }),
  });
  fs.writeFileSync = new Proxy(fs.writeFileSync, {
    apply: (target, receiver, args) =>
      timed("writeMs", () => Reflect.apply(target, receiver, args)),
  });
  fs.renameSync = new Proxy(fs.renameSync, {
    apply: (target, receiver, args) =>
      timed("renameMs", () => Reflect.apply(target, receiver, args)),
  });
  syncBuiltinESMExports();
  store.flushExport = new Proxy(store.flushExport, {
    apply(target, receiver, args) {
      current = {
        snapshotMs: 0,
        stringifyMs: 0,
        writeMs: 0,
        renameMs: 0,
        totalMs: 0,
        otherMs: 0,
        bytes: 0,
        peakRssMiB: 0,
        serializedBytes: 0,
      };
      const started = performance.now();
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        current.totalMs = performance.now() - started;
        current.otherMs =
          current.totalMs -
          current.snapshotMs -
          current.stringifyMs -
          current.writeMs -
          current.renameMs;
        current.bytes = fs.statSync(
          path.join(store.dataDir, "personal-export.json"),
        ).size;
        current.peakRssMiB = process.resourceUsage().maxRSS / 1024;
        const timing = current;
        current = undefined;
        process.send?.({ type: "export", timing });
      }
    },
  });
}

export async function runExportWorker(root: string, mib: number) {
  const workspace = await openFixtureWorkspace(root);
  const notes = "Synthetic benchmark data. ".padEnd(24 * 1024, "x");
  const count = Math.ceil((mib * 1024 * 1024) / notes.length);
  workspace.store.transaction(() => {
    for (let i = 0; i < count; i++)
      workspace.store.put("personal", `synthetic-${i}`, {
        id: `synthetic-${i}`,
        version: 0,
        notes,
      });
  });
  instrumentExports(workspace.store);
  process.on("message", async (message) => {
    if (message === "export") {
      workspace.store.flushExport();
      mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    }
    if (message === "advance") mock.timers.tick(600000);
    if (message === "stop") {
      mock.timers.reset();
      await workspace.close();
      process.disconnect();
    }
  });
  // Expose only isolated fixture URLs, never the installed service's port.
  const health = await workspace.get("/api/health");
  const base = new URL(health.url).origin;
  const session = await (await workspace.get("/api/session")).json();
  process.send?.({
    type: "ready",
    base,
    csrfToken: session.csrfToken,
    records: count,
  });
}
