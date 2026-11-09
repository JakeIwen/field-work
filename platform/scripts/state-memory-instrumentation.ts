import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { Store } from "../app/server/storage.js";

export type MemorySample = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};
export type MemoryResult = {
  operation: string;
  ms: number;
  initial: MemorySample;
  peak: MemorySample;
  final: MemorySample;
  calls: Record<string, number>;
};

export function instrumentMemory(store: Store) {
  let current: MemoryResult | undefined;
  let started = 0;
  const sample = () => {
    const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
    const memory = { rss, heapUsed, external, arrayBuffers };
    if (current)
      for (const key of Object.keys(memory) as (keyof MemorySample)[])
        current.peak[key] = Math.max(current.peak[key], memory[key]);
    return memory;
  };
  const instrument = <T extends (...args: never[]) => unknown>(
    name: string,
    fn: T,
  ): T =>
    new Proxy(fn, {
      apply(target, receiver, args) {
        if (current) current.calls[name] = (current.calls[name] ?? 0) + 1;
        sample();
        try {
          return Reflect.apply(target, receiver, args);
        } finally {
          sample();
        }
      },
    });
  store.state = instrument("state", store.state);
  store.personalExport = instrument("personalExport", store.personalExport);
  store.list = instrument("list", store.list);
  JSON.parse = instrument("parse", JSON.parse);
  JSON.stringify = instrument("stringify", JSON.stringify);
  fs.writeFileSync = instrument("writeFileSync", fs.writeFileSync);
  syncBuiltinESMExports();
  const timer = setInterval(sample, 2);
  return {
    begin() {
      global.gc?.();
      const initial = sample();
      current = {
        operation: "",
        ms: 0,
        initial,
        peak: { ...initial },
        final: initial,
        calls: {},
      };
      started = performance.now();
    },
    end() {
      if (!current) throw Error("Measurement not started");
      current.final = sample();
      current.ms = performance.now() - started;
      const result = current;
      current = undefined;
      return result;
    },
    close() {
      clearInterval(timer);
    },
  };
}
