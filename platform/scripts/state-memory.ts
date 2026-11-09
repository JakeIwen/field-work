import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MemoryResult } from "./state-memory-instrumentation.js";

async function message(child: ChildProcess) {
  const [value] = await once(child, "message");
  if (value.type === "error") throw Error(value.error);
  return value;
}
async function command(child: ChildProcess, operation: string) {
  const next = message(child);
  child.send({ operation });
  return next;
}
function state(base: string, encoding: string) {
  return new Promise<{ bytes: number; hash: string }>((resolve, reject) => {
    get(
      base + "/api/state",
      { headers: { "Accept-Encoding": encoding } },
      (response) => {
        if (response.statusCode !== 200)
          return reject(Error(`HTTP ${response.statusCode}`));
        const hash = createHash("sha256");
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        response.on("end", () => resolve({ bytes, hash: hash.digest("hex") }));
        response.on("error", reject);
      },
    ).on("error", reject);
  });
}
async function main() {
  const hiddenMiB = Number(process.argv[2] ?? 64);
  if (!Number.isFinite(hiddenMiB) || hiddenMiB < 0 || hiddenMiB > 512)
    throw Error("Usage: tsx scripts/state-memory.ts [hidden task MiB, 0–512]");
  const root = mkdtempSync(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "fieldwork-state-memory-"),
  );
  const child = fork(
    import.meta.filename,
    ["--worker", root, String(hiddenMiB)],
    {
      execArgv: ["--expose-gc", "--import", "tsx"],
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 180000);
  const results: MemoryResult[] = [];
  try {
    const ready = await message(child);
    for (const operation of [
      "state-identity",
      "state-br",
      "state-gzip",
      "state-br-6",
      "state-gzip-6",
      "flush",
      "auto-export",
      "pull-state",
      "ledger",
      "export-hour",
    ]) {
      await command(child, "begin");
      let responses: Awaited<ReturnType<typeof state>>[] | undefined;
      if (operation.startsWith("state-")) {
        const [, encoding, count = "1"] = operation.split("-");
        responses = await Promise.all(
          Array.from({ length: Number(count) }, () =>
            state(ready.base, encoding),
          ),
        );
      } else {
        const data = await command(child, operation);
        if (data.pull) console.error(JSON.stringify(data.pull));
      }
      const { result } = await command(child, "end");
      results.push({ ...result, operation, responses });
    }
    console.log(
      JSON.stringify(
        {
          shape: ready.shape,
          runtime: process.version,
          platform: process.platform,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    clearTimeout(deadline);
    const exited = once(child, "exit");
    child.send({ operation: "stop" });
    const force = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(force);
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--worker") {
  const { runMemoryWorker } = await import("./state-memory-worker.js");
  await runMemoryWorker(process.argv[3], Number(process.argv[4]));
} else await main();
