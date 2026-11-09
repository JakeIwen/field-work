#!/usr/bin/env node
import { readFileSync } from "node:fs";

const action = process.argv[2];
if (!["reload", "wait-start", "wait-idle"].includes(action)) {
  console.error("Usage: reload.mjs reload|wait-start|wait-idle");
  process.exit(2);
}

const base = "http://127.0.0.1:4317";
const token = readFileSync("/etc/fieldwork/machine-token", "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid machine token");
const headers = { "x-fieldwork-machine-token": token };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutMs = action === "wait-start" ? 3 * 60_000 : 15 * 60_000;

async function api(path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(3_000),
  });
}

async function health() {
  try {
    const response = await api("/api/health");
    if (!response.ok) return null;
    const value = await response.json();
    return value?.status === "ok" && Number.isSafeInteger(value.pid)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function remainingCount() {
  try {
    const response = await api("/api/system/activity");
    if (!response.ok) return null;
    const value = await response.json();
    return Array.isArray(value?.remaining) ? value.remaining.length : null;
  } catch {
    return null;
  }
}

// One slow answer (a busy turn or a large state response) is not an unhealthy
// service; a single 3 s probe failed a deploy that had just verified idle.
async function settledHealth(windowMs = 30_000) {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const live = await health();
    if (live || Date.now() >= deadline) return live;
    await delay(1_000);
  }
}

async function requestReload() {
  const before = await settledHealth();
  if (!before)
    throw new Error(
      "The active Fieldwork service is not healthy; it was not restarted",
    );
  const session = await api("/api/session");
  if (!session.ok) throw new Error("Could not obtain a Fieldwork session");
  const { csrfToken } = await session.json();
  if (!/^[a-f0-9]{64}$/.test(csrfToken ?? ""))
    throw new Error("Fieldwork returned an invalid CSRF token");
  const response = await api("/api/system/reload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ whenIdle: true }),
  });
  if (!response.ok)
    throw new Error(`Fieldwork refused the idle reload (${response.status})`);
  return before.pid;
}

async function waitForIdle() {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = 0;
  while (Date.now() < deadline) {
    const live = await health();
    const count = live ? await remainingCount() : null;
    if (live && !live.reloading && count === 0) {
      console.log(`Fieldwork is idle (PID ${live.pid}); publication may proceed.`);
      return;
    }
    if (Date.now() >= nextProgress) {
      console.error("Waiting for verified idle work before publishing code.");
      nextProgress = Date.now() + 10_000;
    }
    await delay(1_000);
  }
  throw new Error("Fieldwork did not become idle; code was not published.");
}

if (action === "wait-idle") {
  await waitForIdle();
  process.exit(0);
}

const previousPid = action === "reload" ? await requestReload() : null;
const deadline = Date.now() + timeoutMs;
let nextProgress = 0;
while (Date.now() < deadline) {
  const live = await health();
  if (live && (previousPid === null || live.pid !== previousPid)) {
    console.log(`Fieldwork is healthy (PID ${live.pid}).`);
    process.exit(0);
  }
  if (Date.now() >= nextProgress) {
    if (action === "reload" && live?.pid === previousPid) {
      const count = await remainingCount();
      console.error(
        count === null
          ? "Waiting for Fieldwork to become idle."
          : `Waiting for Fieldwork to become idle: ${count} active item(s).`,
      );
    } else console.error("Waiting for the Fieldwork service to become healthy.");
    nextProgress = Date.now() + 10_000;
  }
  await delay(1_000);
}

if (action === "reload")
  console.error(
    "Timed out waiting for the queued idle reload; the queue remains active and no forced restart was attempted.",
  );
else console.error("Timed out waiting for the newly enabled Fieldwork service.");
process.exit(1);
