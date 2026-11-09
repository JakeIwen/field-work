import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { CompanionConfig } from "./companion-config.js";

type SpawnTunnel = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => ChildProcess;

interface TunnelDependencies {
  spawn?: SpawnTunnel;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  request?: typeof http.request;
}

export function companionSshArguments(config: CompanionConfig) {
  const arguments_ = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-i",
    config.sshIdentityFile,
    "-L",
    `${"127.0.0.1"}:${config.localForwardPort}:127.0.0.1:${config.cloudPort}`,
    "-R",
    `${"127.0.0.1"}:${config.remoteForwardPort}:127.0.0.1:${config.cloudPort}`,
  ];
  arguments_.push(config.sshTarget);
  return arguments_;
}

export function createCompanionTunnel(
  config: CompanionConfig,
  dependencies: TunnelDependencies = {},
) {
  const spawnTunnel = dependencies.spawn ?? spawn;
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  const request = dependencies.request ?? http.request;
  let child: ChildProcess | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let healthRequest: http.ClientRequest | undefined;
  let stopped = false;
  let online = false;
  let failures = 0;

  const cancelHealth = () => {
    if (healthTimer) cancel(healthTimer);
    healthTimer = undefined;
    const request = healthRequest;
    healthRequest = undefined;
    request?.destroy();
  };

  const probe = () => {
    if (stopped || !child) return;
    const owner = child;
    const complete = (healthy: boolean) => {
      if (stopped || child !== owner || healthRequest !== check) return;
      healthRequest = undefined;
      online = healthy;
      if (healthy) failures = 0;
      healthTimer = schedule(probe, 5_000);
    };
    const check = request(
      {
        host: "127.0.0.1",
        port: config.localForwardPort,
        path: "/api/health",
        method: "GET",
        headers: {
          Host: new URL(config.cloudOrigin).host,
          "x-fieldwork-machine-token": config.machineToken,
        },
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        complete(
          (response.statusCode ?? 500) >= 200 &&
            (response.statusCode ?? 500) < 300,
        );
      },
    );
    healthRequest = check;
    check.once("timeout", () => check.destroy());
    check.once("error", () => complete(false));
    check.end();
  };

  const connect = () => {
    if (stopped || child) return;
    const started = spawnTunnel("/usr/bin/ssh", companionSshArguments(config), {
      stdio: "ignore",
    });
    child = started;
    started.once("spawn", () => {
      if (child === started) probe();
    });
    const disconnected = () => {
      if (child !== started) return;
      child = undefined;
      online = false;
      cancelHealth();
      if (stopped) return;
      const delay = Math.min(1_000 * 2 ** failures, 30_000);
      failures = Math.min(failures + 1, 5);
      reconnectTimer = schedule(connect, delay);
    };
    started.once("error", disconnected);
    started.once("exit", disconnected);
  };

  return {
    start: connect,
    connected: () => online,
    close: () => {
      stopped = true;
      online = false;
      if (reconnectTimer) cancel(reconnectTimer);
      reconnectTimer = undefined;
      cancelHealth();
      const closing = child;
      child = undefined;
      if (!closing) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        let force: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (done) return;
          done = true;
          if (force) cancel(force);
          resolve();
        };
        closing.once("exit", finish);
        closing.once("error", finish);
        closing.kill("SIGTERM");
        force = schedule(() => {
          closing.kill("SIGKILL");
        }, 2_000);
      });
    },
  };
}
