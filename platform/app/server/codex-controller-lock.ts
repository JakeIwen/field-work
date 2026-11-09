import { randomUUID, createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  inspectControllerProcess,
  type InspectControllerProcess,
  type ProcessIdentity,
} from "./controller-process.js";

type Owner = {
  pid: number;
  token: string;
  version?: 2;
  identity?: ProcessIdentity;
};
type Snapshot = { owner: Owner; bytes: string; modifiedAt: number };
type Options = { pid?: number; inspect?: InspectControllerProcess };
function code(error: unknown) {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
function validIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as ProcessIdentity;
  return (
    typeof identity.startedAt === "string" &&
    Number.isFinite(Date.parse(identity.startedAt)) &&
    Number.isSafeInteger(identity.uid) &&
    identity.uid >= 0
  );
}
function readLock(file: string): Snapshot {
  const descriptor = openSync(file, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8192)
      throw Error(
        "Codex controller lock is invalid. Inspect it before removing it.",
      );
    const bytes = readFileSync(descriptor, "utf8");
    let owner: Owner;
    try {
      owner = JSON.parse(bytes) as Owner;
    } catch {
      throw Error(
        "Codex controller lock is invalid. Inspect it before removing it.",
      );
    }
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.token !== "string" ||
      !owner.token ||
      owner.token.length > 200 ||
      (owner.version !== undefined && owner.version !== 2) ||
      (owner.identity !== undefined && !validIdentity(owner.identity))
    )
      throw Error(
        "Codex controller lock is invalid. Inspect it before removing it.",
      );
    return { owner, bytes, modifiedAt: stat.mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

/** The PID plus its process birth identity identifies the controller, not the PID alone. */
export class CodexControllerLock {
  private held = false;
  private readonly token = randomUUID();
  private readonly pid: number;
  private readonly inspect: InspectControllerProcess;
  private readonly file: string;
  constructor(dataDir: string, options: Options = {}) {
    this.file = path.join(dataDir, "codex-controller.lock");
    this.pid = options.pid ?? process.pid;
    this.inspect = options.inspect ?? inspectControllerProcess;
  }
  get owned() {
    return this.held;
  }
  private owner(): Owner {
    const process = this.inspect(this.pid);
    return {
      version: 2,
      pid: this.pid,
      token: this.token,
      ...(process.state === "alive" && process.identity
        ? { identity: process.identity }
        : {}),
    };
  }
  private stale(snapshot: Snapshot) {
    const current = this.inspect(snapshot.owner.pid);
    if (current.state === "dead") return true;
    if (current.state === "alive" && current.identity) {
      const old = snapshot.owner.identity;
      if (
        old &&
        (old.uid !== current.identity.uid ||
          old.startedAt !== current.identity.startedAt)
      )
        return true;
      // Legacy files have no birth identity. A process born after the lock cannot own it.
      if (
        !old &&
        Date.parse(current.identity.startedAt) > snapshot.modifiedAt + 1000
      )
        return true;
    }
    if (current.state === "unknown")
      throw Error(
        `Cannot verify ownership of the existing Codex controller lock (PID ${snapshot.owner.pid}; ${current.reason}). No lock was removed.`,
      );
    throw Error(
      `Another application process controls these Codex threads (PID ${snapshot.owner.pid}). Stop that application before connecting here.`,
    );
  }
  private reclaim(snapshot: Snapshot) {
    const hash = createHash("sha256").update(snapshot.bytes).digest("hex");
    const guard = `${this.file}.reclaim-${hash}`;
    // Serialize reclaimers of this exact stale lock so one cannot delete a replacement lock.
    try {
      writeFileSync(guard, JSON.stringify(this.owner()), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (code(e) === "EEXIST")
        throw Error(
          "Codex lock recovery is in progress or was interrupted. Retry; if it persists, inspect the reclaim marker before removing it.",
        );
      throw e;
    }
    try {
      let latest: Snapshot;
      try {
        latest = readLock(this.file);
      } catch (e) {
        if (code(e) === "ENOENT") return;
        throw e;
      }
      if (latest.bytes !== snapshot.bytes || !this.stale(latest)) return;
      unlinkSync(this.file);
    } finally {
      if (readLock(guard).owner.token === this.token) unlinkSync(guard);
    }
  }
  acquire() {
    if (this.held) return;
    for (let attempts = 0; attempts < 4; attempts++) {
      try {
        writeFileSync(this.file, JSON.stringify(this.owner()), {
          flag: "wx",
          mode: 0o600,
        });
        this.held = true;
        return;
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
      }
      let snapshot: Snapshot;
      try {
        snapshot = readLock(this.file);
      } catch (e) {
        if (code(e) === "ENOENT") continue;
        throw e;
      }
      if (this.stale(snapshot)) this.reclaim(snapshot);
    }
    throw Error(
      "Codex controller ownership changed repeatedly. Retry after the other connection attempt finishes.",
    );
  }
  release() {
    if (!this.held) return;
    try {
      if (readLock(this.file).owner.token === this.token) unlinkSync(this.file);
    } catch {
      /* A removed/replaced lock is never ours to repair during shutdown. */
    }
    this.held = false;
  }
}
