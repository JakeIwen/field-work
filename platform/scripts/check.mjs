import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateGroup } from "./process-group.mjs";
import { withLock } from "./run-locked.mjs";

const platform = fileURLToPath(new URL("../", import.meta.url));
const defaultTimeoutMs = 15 * 60_000;
const defaultTerminationGraceMs = 2_000;

/** Run one suite command in a process group owned by this invocation. */
export async function runCommand(
  command,
  args,
  {
    cwd = platform,
    env = {},
    signal,
    stdio = "inherit",
    timeoutMs = defaultTimeoutMs,
    terminationGraceMs = defaultTerminationGraceMs,
  } = {},
) {
  if (signal?.aborted) throw new Error(`${command} was cancelled`);
  console.log(`Checking: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio,
    detached: true,
  });
  const group = child.pid;
  const cleanup = async () => {
    try {
      await terminateGroup(group, terminationGraceMs);
    } catch (error) {
      error.scratchMayBeInUse = true;
      throw error;
    }
  };
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, childSignal) =>
      resolve({ code, signal: childSignal }),
    );
  });
  let timeout;
  let cancel;
  const interrupted = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (signal) {
      cancel = () => resolve({ kind: "cancelled" });
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    }
  });

  try {
    const outcome = await Promise.race([
      exited.then((result) => ({ kind: "exit", result })),
      interrupted,
    ]);
    if (outcome.kind !== "exit") {
      await cleanup();
      await exited;
      throw new Error(
        `${command} ${args.join(" ")} ${outcome.kind === "timeout" ? `timed out after ${timeoutMs}ms` : "was cancelled"}`,
      );
    }

    // A command can exit while a background descendant keeps its process group
    // alive. No suite step is allowed to leave one behind.
    await cleanup();
    const { error, code, signal: childSignal } = outcome.result;
    if (error) throw error;
    if (code !== 0)
      throw new Error(
        `${command} ${args.join(" ")} failed (${code ?? childSignal ?? "unknown"})`,
      );
  } finally {
    clearTimeout(timeout);
    if (signal && cancel) signal.removeEventListener("abort", cancel);
  }
}

export async function runChecks({ signal } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), "fieldwork-check-"));
  let retained = false;
  const run = (command, args, env) =>
    runCommand(command, args, { cwd: platform, env, signal });
  try {
    await run("npm", ["test"]); // fast tier
    await run("npm", ["run", "test:native"]); // takes its own native lock
    await run("npm", [
      "run",
      "build",
      "--",
      "--outDir",
      path.join(scratch, "dist"),
      "--emptyOutDir",
    ]);
    await run("npm", ["run", "format:check"]);
    await run("npm", ["run", "lint"]);
    await run("bash", ["deploy/test.sh"]);
    if (process.platform === "darwin") {
      // The fixture compiles Swift like test:native does, so it takes the same
      // machine-wide native lock (test:native takes its own, so it is not held
      // around that stage).
      const root = path.join(scratch, "workspace");
      cpSync(path.join(platform, "sample-workspace"), root, {
        recursive: true,
      });
      await withLock(
        "native",
        () =>
          run("npm", ["run", "verify:release", "--", "--use-env"], {
            JOB_SEARCH_ROOT: root,
            JOB_SEARCH_DATA: path.join(scratch, "data"),
            JOB_SEARCH_VERIFICATION_REPORT: path.join(
              scratch,
              "verification.json",
            ),
          }),
        ["npm", "run", "verify:release"],
      );
    } else {
      console.log(
        "SKIP native PDF release fixture: requires macOS Swift/WebKit.",
      );
    }
    console.log("Fieldwork complete offline check passed.");
  } catch (error) {
    if (error.scratchMayBeInUse) {
      retained = true;
      console.error(
        `Process cleanup failed; preserving scratch data at ${scratch}`,
      );
    }
    throw error;
  } finally {
    if (!retained) rmSync(scratch, { recursive: true, force: true });
  }
}

export async function main() {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    // One full check at a time per machine: its native stages compile Swift
    // and trip real deadlines when sessions overlap. Only this group is ever
    // signalled; other sessions' processes are never matched.
    await withLock("check", () => runChecks({ signal: controller.signal }), [
      "npm",
      "run",
      "check",
    ]);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
