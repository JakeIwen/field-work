import { mock } from "node:test";
import { measurePullCycle } from "./state-memory-pull.js";
import type { Store } from "../app/server/storage.js";

/** Advance only this disposable worker's scheduler; no live clocks or services. */
export async function measureExportHour(store: Store) {
  const writes: Record<string, number> = {};
  let exports = 0;
  let serializedBytes = 0;
  let exporting = false;
  const put = store.put;
  const flush = store.flushExport;
  const stringify = JSON.stringify;
  store.put = new Proxy(put, {
    apply(target, receiver, args) {
      writes[args[0]] = (writes[args[0]] ?? 0) + 1;
      return Reflect.apply(target, receiver, args);
    },
  });
  store.flushExport = new Proxy(flush, {
    apply(target, receiver, args) {
      exports++;
      exporting = true;
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        exporting = false;
      }
    },
  });
  JSON.stringify = new Proxy(stringify, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (exporting && typeof result === "string")
        serializedBytes += Buffer.byteLength(result);
      return result;
    },
  });
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    const pull = await measurePullCycle(store, {
      ticks: 120,
      stepMs: 30000,
      advance: (ms) => mock.timers.tick(ms),
    });
    return { ...pull, exports, serializedBytes, writes };
  } finally {
    mock.timers.reset();
    store.put = put;
    store.flushExport = flush;
    JSON.stringify = stringify;
  }
}
