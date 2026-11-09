import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExportTiming } from "./export-latency-worker.js";

type Ready = {
  type: "ready";
  base: string;
  csrfToken: string;
  records: number;
};
type WorkerMessage = Ready | { type: "export"; timing: ExportTiming };

function probeHealth(base: string) {
  const samples: { sent: number; received: number; ok: boolean }[] = [];
  const pending = new Set<Promise<void>>();
  const timer = setInterval(() => {
    const sent = performance.now();
    const request = fetch(base + "/api/health", {
      signal: AbortSignal.timeout(20000),
    })
      .then(async (response) => {
        await response.arrayBuffer();
        samples.push({ sent, received: performance.now(), ok: response.ok });
      })
      .catch(() => {
        samples.push({ sent, received: performance.now(), ok: false });
      })
      .finally(() => {
        pending.delete(request);
      });
    // Never await the previous probe: a blocked worker must not suppress samples.
    pending.add(request);
  }, 20);
  return async () => {
    clearInterval(timer);
    await Promise.all(pending);
    return samples;
  };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return {
    p50: percentile(0.5),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0,
  };
}

async function readyWorker(child: ChildProcess) {
  return new Promise<Ready>((resolve, reject) => {
    child.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") resolve(message);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Worker exited before ready (${code})`)),
    );
  });
}

async function measure(
  child: ChildProcess,
  ready: Ready,
  exports: ExportTiming[],
) {
  const stopProbes = probeHealth(ready.base);
  const interrupted = new AbortController();
  const onExit = () =>
    interrupted.abort(new Error("Export worker exited during measurement"));
  child.once("exit", onExit);
  try {
    await delay(500);
    const exported = once(child, "message", { signal: interrupted.signal });
    child.send("export");
    await exported;
    await delay(500);
    const delayedExport = once(child, "message", {
      signal: interrupted.signal,
    });
    const started = performance.now();
    const mutation = await fetch(
      ready.base + "/api/personal/latency-mutation",
      {
        method: "POST",
        signal: AbortSignal.any([
          interrupted.signal,
          AbortSignal.timeout(30000),
        ]),
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": ready.csrfToken,
        },
        body: JSON.stringify({
          expectedVersion: 0,
          notes: "Measured real mutation",
        }),
      },
    );
    const result = await mutation.json();
    const mutationMs = performance.now() - started;
    if (!mutation.ok) throw new Error(JSON.stringify(result));
    child.send("advance");
    await delayedExport;
    const exportFreshnessMs = performance.now() - started;
    await delay(500);
    const samples = await stopProbes();
    const received = samples.map((s) => s.received).sort((a, b) => a - b);
    const sent = samples.map((s) => s.sent).sort((a, b) => a - b);
    return {
      records: ready.records,
      exportMiB: exports.map((e) => e.bytes / 1024 / 1024),
      exports,
      mutationMs,
      exportFreshnessMs,
      simulatedClockAdvanceMs: 600000,
      probeIntervalMs: 20,
      probes: samples.length,
      failedProbes: samples.filter((s) => !s.ok).length,
      healthLatencyMs: distribution(samples.map((s) => s.received - s.sent)),
      healthCompletionGapMs: distribution(
        received.slice(1).map((time, i) => time - received[i]),
      ),
      probeDispatchGapMs: distribution(
        sent.slice(1).map((time, i) => time - sent[i]),
      ),
      peakWorkerRssMiB: Math.max(...exports.map((e) => e.peakRssMiB)),
    };
  } finally {
    child.removeListener("exit", onExit);
    await stopProbes();
  }
}

async function main() {
  const mib = Number(process.argv[2] ?? 100);
  if (!Number.isFinite(mib) || mib < 1 || mib > 512)
    throw new Error("Usage: tsx scripts/export-latency.ts [MiB, 1–512]");
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-export-latency-"));
  const child = fork(import.meta.filename, ["--worker", root, String(mib)], {
    execArgv: ["--import", "tsx"],
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const timings: ExportTiming[] = [];
  child.on("message", (message: WorkerMessage) => {
    if (message.type === "export") timings.push(message.timing);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120000);
  try {
    const ready = await readyWorker(child);
    const report = await measure(child, ready, timings);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.send("stop");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  const { runExportWorker } = await import("./export-latency-worker.js");
  await runExportWorker(process.argv[3], Number(process.argv[4]));
} else {
  await main();
}
