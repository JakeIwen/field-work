// Machine-wide queueing lock for slow commands (the native Swift tier, the
// full check, the production deploy). Parallel sessions otherwise run several
// cold Swift compiles at once and trip real 60 s deadlines.
// Usage: run-locked.mjs <name> -- <cmd> [args]
//        run-locked.mjs --path <name> | --describe <name>   (read-only)
//
// Mutual exclusion rests on mkdir. Every holder writes a random token into
// owner.json; only the process whose token is in the file may remove the lock,
// and a dead holder's lock is reclaimed only by the one contender that holds
// the recovery guard (<lock>.recover) and has re-checked, under it, that the
// lock still carries the dead owner's token.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateGroup } from "./process-group.mjs";

const platform = fileURLToPath(new URL("../", import.meta.url));

// A worktree shares the main checkout's lock root, so sessions in different
// worktrees still queue behind each other; the env override is for tests.
function lockRoot() {
  if (process.env.FIELDWORK_LOCK_ROOT) return process.env.FIELDWORK_LOCK_ROOT;
  let top = path.resolve(platform, "..");
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: platform, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (path.basename(common) === ".git") top = path.dirname(common);
  } catch {
    // not a git checkout: the repo root above is the best shared location
  }
  return path.join(top, ".local", "locks");
}
export const locksDirectory = lockRoot();
export const lockPath = (name) => path.join(locksDirectory, name);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envMs = (name, fallback) => Number(process.env[name]) || fallback;
const pollMs = () => envMs("FIELDWORK_LOCK_POLL_MS", 2000);
const noticeMs = () => envMs("FIELDWORK_LOCK_NOTICE_MS", 30_000);
// How long a lock directory may lack a readable owner.json before it counts as
// abandoned: a live holder writes it within milliseconds of mkdir.
const fluxMs = () => envMs("FIELDWORK_LOCK_FLUX_MS", 10_000);
// A recovery guard is held for milliseconds; an older one belonged to a
// contender that died inside the critical section.
const guardStaleMs = () => envMs("FIELDWORK_LOCK_GUARD_STALE_MS", 10_000);
const graceMs = () => envMs("FIELDWORK_LOCK_GRACE_MS", 2000);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user
    return error?.code === "EPERM";
  }
}

function readOwner(dir) {
  try {
    const owner = JSON.parse(
      readFileSync(path.join(dir, "owner.json"), "utf8"),
    );
    return owner && typeof owner === "object" && Number.isInteger(owner.pid)
      ? owner
      : null;
  } catch {
    return null;
  }
}

function ageMs(target) {
  try {
    return Date.now() - statSync(target).mtimeMs;
  } catch {
    return null; // gone
  }
}

function removeAside(target) {
  const aside = `${target}.dead.${process.pid}.${randomUUID()}`;
  try {
    renameSync(target, aside);
  } catch {
    return false;
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}

const clock = (iso) => new Date(iso).toTimeString().slice(0, 5);
const holderText = (owner) =>
  `pid ${owner.pid} since ${clock(owner.started)} (${[].concat(owner.argv ?? []).join(" ")})`;

/** One line for a dry run: free, held by a live owner, or abandoned. */
export function describeLock(name) {
  const dir = lockPath(name);
  if (ageMs(dir) === null) return "free";
  const owner = readOwner(dir);
  if (owner && pidAlive(owner.pid))
    return `held by ${holderText(owner)}; a real run would wait`;
  return "held by a dead or unreadable owner; a real run would reclaim it";
}

/**
 * Remove an abandoned lock. `inspected` is the owner the caller saw (null for
 * an ownerless directory). Only the contender holding the recovery guard acts,
 * and it re-reads the owner first, so a lock another process has since taken
 * over is never touched.
 */
function reclaim(name, dir, inspected) {
  const guard = `${dir}.recover`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const age = ageMs(guard);
    if (age !== null && age > guardStaleMs()) removeAside(guard);
    return false;
  }
  try {
    const owner = readOwner(dir);
    if (inspected) {
      if (!owner || owner.token !== inspected.token || pidAlive(owner.pid))
        return false;
    } else {
      const age = ageMs(dir);
      if (owner || age === null || age <= fluxMs()) return false;
    }
    if (!removeAside(dir)) return false;
    console.log(
      inspected
        ? `stale ${name} lock held by dead pid ${inspected.pid} reclaimed`
        : `stale ${name} lock (no owner) reclaimed`,
    );
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/** Take the named lock, waiting while a live process holds it. */
export async function acquireLock(name, argv = process.argv.slice(1)) {
  const dir = lockPath(name);
  mkdirSync(locksDirectory, { recursive: true });
  const token = randomUUID();
  let lastNotice = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      // Rename into place so a reader sees a whole owner.json or none.
      const pending = path.join(dir, `owner.${token}.tmp`);
      writeFileSync(
        pending,
        JSON.stringify({
          pid: process.pid,
          token,
          started: new Date().toISOString(),
          argv,
          cwd: process.cwd(),
        }),
      );
      renameSync(pending, path.join(dir, "owner.json"));
      return () => {
        // Only the holder whose token is in the file removes the lock.
        if (readOwner(dir)?.token === token) removeAside(dir);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const owner = readOwner(dir);
    if (!owner) {
      // Between mkdir and owner.json, or a holder that died in that gap: in
      // flux, so wait, and reclaim only once it has stayed that way too long.
      const age = ageMs(dir);
      if (age !== null && age > fluxMs() && reclaim(name, dir, null)) continue;
    } else if (!pidAlive(owner.pid)) {
      if (reclaim(name, dir, owner)) continue;
    } else if (Date.now() - lastNotice >= noticeMs()) {
      lastNotice = Date.now();
      console.log(`waiting for ${name} lock held by ${holderText(owner)}`);
    }
    await wait(pollMs() * (1 + Math.random() * 0.25));
  }
}

/** Run fn while holding the named lock; released on every exit path. */
export async function withLock(name, fn, argv) {
  const release = await acquireLock(name, argv);
  console.log(`${name} pid ${process.pid}`);
  const onExit = () => release();
  process.once("exit", onExit);
  try {
    return await fn();
  } finally {
    process.removeListener("exit", onExit);
    release();
  }
}

const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 };

// The lock outlives the command's whole process group, not just the command:
// a grandchild still compiling or serving would otherwise overlap the next
// holder.
function runInGroup(command, args) {
  const child = spawn(command, args, { stdio: "inherit", detached: true });
  const forward = (signal) => () => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  };
  const handlers = ["SIGINT", "SIGTERM"].map((s) => [s, forward(s)]);
  for (const [s, h] of handlers) process.on(s, h);
  return new Promise((resolve) => {
    const finish = (code) => {
      for (const [s, h] of handlers) process.removeListener(s, h);
      resolve(code);
    };
    child.once("error", (error) => {
      console.error(error.message);
      finish(127);
    });
    child.once("exit", async (code, signal) => {
      try {
        await terminateGroup(child.pid, graceMs());
      } catch (error) {
        console.error(`run-locked: ${error.message}`);
      }
      finish(code ?? (signal ? 128 + (signalNumbers[signal] ?? 1) : 1));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--path" || argv[0] === "--describe") {
    if (argv.length !== 2) {
      console.error("usage: run-locked.mjs --path|--describe <name>");
      return 2;
    }
    console.log(
      argv[0] === "--path" ? lockPath(argv[1]) : describeLock(argv[1]),
    );
    return 0;
  }
  const split = argv.indexOf("--");
  if (split < 1 || split === argv.length - 1) {
    console.error("usage: run-locked.mjs <name> -- <command> [args...]");
    return 2;
  }
  const name = argv[0];
  const [command, ...args] = argv.slice(split + 1);
  return withLock(name, () => runInGroup(command, args), argv.slice(split + 1));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
