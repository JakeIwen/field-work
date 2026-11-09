import { tunableMs } from "./tunables.js";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "./storage.js";
import { remoteRenderPlan, runRemoteRender } from "./remote-render-client.js";

const execute = promisify(execFile);
const interruptedMessage =
  "Generation interrupted by Reload app. Retry when the app is ready.";
type GenerationState = {
  controller: AbortController;
  jobs: Set<Promise<void>>;
};
const workspaces = new WeakMap<Store, GenerationState>();

function state(store: Store) {
  let value = workspaces.get(store);
  if (!value) {
    value = {
      controller: new AbortController(),
      jobs: new Set(),
    };
    workspaces.set(store, value);
  }
  return value;
}

export const hasActiveGenerations = (store: Store) =>
  !!workspaces.get(store)?.jobs.size;

export function assertGenerationActive(store: Store) {
  if (state(store).controller.signal.aborted)
    throw new Error(interruptedMessage);
}

export function generationFailure(store: Store, error: unknown) {
  return state(store).controller.signal.aborted
    ? new Error(interruptedMessage)
    : error instanceof Error
      ? error
      : new Error(String(error));
}

export const generationSignal = (store: Store) =>
  state(store).controller.signal;

/** Keep the Store open until cancelled work has finished its cleanup. */
export function beginGeneration(store: Store) {
  assertGenerationActive(store);
  const current = state(store);
  let resolve: () => void = () => {};
  const finished = new Promise<void>((done) => {
    resolve = done;
  });
  current.jobs.add(finished);
  return () => {
    current.jobs.delete(finished);
    resolve();
  };
}

export async function runGenerationProcess(
  store: Store,
  command: string,
  args: string[],
  options: Omit<ExecFileOptions, "signal" | "encoding">,
) {
  const finish = beginGeneration(store);
  const current = state(store);
  try {
    const remote = remoteRenderPlan(store, command, args);
    if (remote) {
      try {
        return await runRemoteRender(
          remote,
          current.controller.signal,
          options,
          store,
        );
      } catch (error) {
        throw generationFailure(store, error);
      }
    }
    const execution = execute(command, args, {
      ...options,
      encoding: "utf8",
      signal: current.controller.signal,
    });
    try {
      return await execution;
    } catch (error) {
      throw generationFailure(store, error);
    } finally {
      const child = execution.child;
      if (
        current.controller.signal.aborted &&
        child.pid &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        const force = setTimeout(
          () => child.kill("SIGKILL"),
          tunableMs(store, "documents.renderKillGraceS"),
        );
        await new Promise<void>((resolve) =>
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          }),
        );
      }
    }
  } finally {
    finish();
  }
}

export async function abortGenerations(store: Store) {
  const current = state(store);
  current.controller.abort(new Error(interruptedMessage));
  await Promise.allSettled([...current.jobs]);
}
