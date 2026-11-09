import net from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
export function demoAddressAllowed(
  host: string,
  port: number,
  ports: readonly number[] = [],
) {
  return (
    loopbackHosts.has(host) &&
    Number.isInteger(port) &&
    ports.includes(port) &&
    ![4317, 44317].includes(port)
  );
}

/** In-process containment: children and UDP cannot bypass the socket/DNS checks. */
export function guardDemoNetwork(logFile: string, ports: readonly number[]) {
  const undo: (() => void)[] = [];
  const block = (
    boundary: string,
    details: Record<string, unknown> = {},
  ): never => {
    appendFileSync(
      logFile,
      JSON.stringify({ boundary, ...details, blocked: true }) + "\n",
    );
    throw new Error(
      `Demo blocks ${boundary}; only its explicitly allowed loopback ports are available`,
    );
  };
  const replace = (object: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    Object.defineProperty(object, key, { ...descriptor, value });
    undo.push(() => Object.defineProperty(object, key, descriptor));
  };
  const connect = net.Socket.prototype.connect;
  replace(
    net.Socket.prototype,
    "connect",
    function (this: net.Socket, ...args: unknown[]) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const first = normalized[0];
      const options =
        typeof first === "object" && first !== null
          ? (first as { host?: string; port?: number; path?: string })
          : {
              port: Number(first),
              host:
                typeof normalized[1] === "string" ? normalized[1] : "localhost",
            };
      const host = options.host ?? "localhost";
      const port = Number(options.port);
      if (options.path || !demoAddressAllowed(host, port, ports))
        block("connection", { host, port });
      return Reflect.apply(connect, this, args);
    },
  );
  guardDns(replace, block);
  replace(dgram, "createSocket", () => block("UDP socket"));
  for (const key of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    replace(childProcess, key, () =>
      block("child process", { operation: key }),
    );
  }
  replace(childProcess.ChildProcess.prototype, "spawn", () =>
    block("child process"),
  );
  syncBuiltinESMExports();
  return () => {
    for (const restore of undo.reverse()) restore();
    syncBuiltinESMExports();
  };
}

type Replace = (object: object, key: string, value: unknown) => void;
type Block = (boundary: string, details?: Record<string, unknown>) => never;

function guardDns(replace: Replace, block: Block) {
  // lookup is needed for a caller using localhost; other DNS operations can
  // send packets without ever opening a net.Socket, so none are delegated.
  for (const object of [dns, dnsPromises]) {
    for (const key of Object.keys(object)) {
      if (key === "lookup") {
        const lookup = Reflect.get(object, key);
        replace(
          object,
          key,
          function (this: unknown, host: string, ...args: unknown[]) {
            if (!loopbackHosts.has(host)) block("DNS lookup", { host });
            return Reflect.apply(lookup, this, [host, ...args]);
          },
        );
      } else if (/^(resolve|reverse|lookupService)/.test(key)) {
        replace(object, key, () => block("DNS resolution"));
      }
    }
  }
  for (const prototype of [
    dns.Resolver.prototype,
    dnsPromises.Resolver.prototype,
  ]) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (/^(resolve|reverse)/.test(key))
        replace(prototype, key, () => block("DNS resolver"));
    }
  }
}
