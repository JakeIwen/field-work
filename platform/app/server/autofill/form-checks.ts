import { tunableMs } from "../tunables.js";
import { setTimeout as pause } from "node:timers/promises";
import { hostedApplication } from "../../shared/application-host.js";
import { supportsApplicationAutofill } from "../application-autofill-providers.js";
import { isClosedOpening } from "../../shared/opening-availability.js";
import type {
  OpeningFormCheck,
  OpeningFormCheckPass,
} from "../../shared/opening-form-check.js";
import type { CareersFetch } from "../careers/http.js";
import { publicCareersFetch } from "../careers/http.js";
import { diagnosticLog } from "../diagnostic-log.js";
import { beginGeneration, generationSignal } from "../generation-control.js";
import { greenhouseApi } from "../greenhouse-application-adapter.js";
import { loadGreenhouseApplication } from "../greenhouse-application-source.js";
import type { Opening } from "../../shared/types.js";
import { now, type Store } from "../storage.js";
import { autofillReader } from "./fetch.js";
import { formQuestionCounts } from "./form-questions.js";
import { readAutofillProfile } from "./profile.js";

const passes = new WeakMap<Store, OpeningFormCheckPass>();

export const activeFormCheckPass = (store: Store) => {
  const pass = passes.get(store);
  return pass?.running ? pass : undefined;
};

/** Serialize the API, hosted/direct form and every retry through the same gate. */
function pacedReader(
  read: CareersFetch,
  signal: AbortSignal,
  interval: () => number,
): CareersFetch {
  let previous = Promise.resolve();
  let lastRequest = 0;
  return (url) => {
    const request = previous.then(async () => {
      while (Date.now() - lastRequest < interval())
        await pause(interval() - (Date.now() - lastRequest), undefined, {
          signal,
        });
      signal.throwIfAborted();
      lastRequest = Date.now();
      return read(url);
    });
    previous = request.then(
      () => {},
      () => {},
    );
    return request;
  };
}

async function checkOpening(
  store: Store,
  openingId: string,
  read: CareersFetch,
) {
  const opening = store.opening(openingId);
  if (
    !opening ||
    store.get("personal", openingId)?.dismissed ||
    isClosedOpening(opening)
  ) {
    diagnosticLog(
      "info",
      "form-checks",
      "Skipped missing or inactive Opening",
      { openingId },
    );
    return;
  }
  const result: OpeningFormCheck = {
    openingId,
    checkedAt: now(),
    openingHash: opening.hash,
    profileHash: "",
    status: "unsupported",
    personal: [],
    narrative: 0,
  };
  try {
    const { profile, hash } = readAutofillProfile(store);
    result.profileHash = hash;
    const identity = hostedApplication(opening.url);
    if (identity?.provider === "greenhouse") {
      const source = await loadGreenhouseApplication(
        identity,
        autofillReader(store, openingId, { read }),
      );
      Object.assign(
        result,
        formQuestionCounts(
          source.applicationUrl,
          source.applicationHtml,
          greenhouseApi(source.postingPayload),
          profile,
        ),
      );
      result.status = "ok";
    }
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  // A deletion or source replacement during retrieval must never resurrect work.
  if (store.opening(openingId)?.hash === opening.hash) {
    result.checkedAt = now();
    store.put("opening_form_check", openingId, result);
  }
}

/** One runner per Store: a single loop drains `queue`, so ids enqueued mid-pass join it. */
type FormCheckRunner = { pass: OpeningFormCheckPass; queue: string[] };
const runners = new WeakMap<Store, FormCheckRunner>();

const checkable = (store: Store, opening: Opening) =>
  !store.get("personal", opening.id)?.dismissed &&
  !isClosedOpening(opening) &&
  supportsApplicationAutofill(opening.url);

function beginRunner(
  store: Store,
  ids: string[],
  publish: () => void,
  read?: CareersFetch,
): OpeningFormCheckPass {
  const finish = beginGeneration(store);
  const signal = generationSignal(store);
  const reader = pacedReader(
    read ??
      ((url) =>
        publicCareersFetch(url, signal, undefined, () => store.settings())),
    signal,
    () => tunableMs(store, "autofill.formCheckSpacingMs"),
  );
  const pass: OpeningFormCheckPass = {
    startedAt: now(),
    queued: ids.length,
    completed: 0,
    running: true,
  };
  const runner: FormCheckRunner = { pass, queue: [...ids] };
  passes.set(store, pass);
  runners.set(store, runner);
  // Yield before the first read so POST always returns the queued pass immediately.
  void Promise.resolve()
    .then(async () => {
      try {
        while (runner.queue.length && !signal.aborted) {
          await checkOpening(store, runner.queue.shift()!, reader);
          pass.completed++;
          publish();
        }
      } finally {
        runner.queue.length = 0;
        pass.running = false;
        finish();
        publish();
      }
    })
    .catch((error) =>
      diagnosticLog(
        "error",
        "form-checks",
        "Form check pass stopped",
        {},
        error,
      ),
    );
  return { ...pass };
}

export function startFormCheckPass(
  store: Store,
  publish: () => void,
  read?: CareersFetch,
): OpeningFormCheckPass {
  const active = activeFormCheckPass(store);
  if (active) return { ...active };
  const targets = store
    .openings()
    .filter((opening) => checkable(store, opening))
    .map((opening) => opening.id);
  return beginRunner(store, targets, publish, read);
}

/** Check just these Openings: join the running pass, or start one over them. */
export function enqueueFormChecks(
  store: Store,
  openingIds: string[],
  publish: () => void,
  read?: CareersFetch,
): OpeningFormCheckPass | undefined {
  const ids = [
    ...new Set(
      openingIds.filter((id) => {
        const opening = store.opening(id);
        return opening && checkable(store, opening);
      }),
    ),
  ];
  const active = activeFormCheckPass(store);
  const runner = runners.get(store);
  if (active && runner) {
    const added = ids.filter((id) => !runner.queue.includes(id));
    runner.queue.push(...added);
    active.queued += added.length;
    return { ...active };
  }
  if (!ids.length) return undefined;
  return beginRunner(store, ids, publish, read);
}
