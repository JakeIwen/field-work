/** Named server-sent events that only mean "refresh the state". */
const invalidationEvents = ["change", "state", "invalidate", "invalidation", "task", "agent"];
const closedState = 2; // EventSource.CLOSED
const maxRetryMs = 30_000;
const coordinationName = "fieldwork-live-events";

type LiveSource = {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener: (name: string, listener: () => void) => void;
  close: () => void;
};

type LiveEvent = { type: "open" | "error" | "invalidate" } | { type: "message"; data: string };
type ChannelMessage = LiveEvent | { type: "status-request" } | { type: "status"; connected: boolean };
type LiveChannel = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: ChannelMessage) => void;
  close: () => void;
};

export type LiveEventHandlers = {
  /** `reconnected` is true for every open after the first, when missed changes need a full refresh. */
  open: (reconnected: boolean) => void;
  error: () => void;
  message: (event: { data: string }) => void;
  invalidate: () => void;
};

export type LiveEventRuntime = {
  create: (url: string) => LiveSource;
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  requestLock?: (name: string, signal: AbortSignal, hold: () => Promise<void>) => Promise<void>;
  createChannel?: (name: string) => LiveChannel;
};

const browserRuntime: LiveEventRuntime = {
  create: (url) => new EventSource(url),
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestLock: typeof navigator !== "undefined" && navigator.locks
    ? async (name, signal, hold) => { await navigator.locks.request(name, { mode: "exclusive", signal }, hold); }
    : undefined,
  createChannel: typeof BroadcastChannel !== "undefined" ? (name) => new BroadcastChannel(name) : undefined,
};

function readChannelMessage(value: unknown): ChannelMessage | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  switch (value.type) {
    case "open": case "error": case "invalidate": case "status-request":
      return { type: value.type };
    case "message":
      if ("data" in value && typeof value.data === "string") return { type: "message", data: value.data };
      return;
    case "status":
      if ("connected" in value && typeof value.connected === "boolean") return { type: "status", connected: value.connected };
  }
}

function connectStream(emit: (event: LiveEvent) => void, runtime: LiveEventRuntime) {
  let source: LiveSource | undefined;
  let retry: unknown;
  let failures = 0;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    retry = undefined;
    const current = runtime.create("/api/events");
    source = current;
    const active = () => !stopped && current === source;
    current.onopen = () => {
      if (!active()) return;
      failures = 0;
      emit({ type: "open" });
    };
    current.onerror = () => {
      if (!active()) return;
      emit({ type: "error" });
      if (stopped || current.readyState !== closedState || retry !== undefined) return;
      current.close();
      retry = runtime.schedule(open, Math.min(maxRetryMs, 1000 * 2 ** failures++));
    };
    current.onmessage = (event) => {
      if (active() && typeof event.data === "string") emit({ type: "message", data: event.data });
    };
    invalidationEvents.forEach((name) => current.addEventListener(name, () => {
      if (active()) emit({ type: "invalidate" });
    }));
  };
  open();
  return () => {
    stopped = true;
    if (retry !== undefined) runtime.cancel(retry);
    source?.close();
  };
}

function connectSharedStream(
  emit: (event: LiveEvent) => void, runtime: LiveEventRuntime,
  channel: LiveChannel, requestLock: NonNullable<LiveEventRuntime["requestLock"]>,
) {
  const controller = new AbortController();
  let leader = false;
  // Unset until the leader's stream first opens or fails, so a tab joining a
  // still-connecting leader waits for that outcome instead of flashing "disconnected".
  let connected: boolean | undefined;
  let awaitingStatus = true;
  let releaseLock: (() => void) | undefined;
  let closeStream: (() => void) | undefined;
  const relay = (event: LiveEvent) => {
    if (controller.signal.aborted) return;
    if (event.type === "open" || event.type === "error") connected = event.type === "open";
    channel.postMessage(event);
    emit(event);
  };
  channel.onmessage = ({ data }) => {
    if (controller.signal.aborted) return;
    const event = readChannelMessage(data);
    if (!event) return;
    if (event.type === "status-request") {
      if (leader && connected !== undefined) channel.postMessage({ type: "status", connected });
    } else if (!leader) {
      if (event.type === "status") {
        if (!awaitingStatus) return;
        awaitingStatus = false;
        emit({ type: event.connected ? "open" : "error" });
      } else {
        if (event.type === "open" || event.type === "error") awaitingStatus = false;
        emit(event);
      }
    }
  };
  void requestLock(coordinationName, controller.signal, async () => {
    if (controller.signal.aborted) return;
    leader = true;
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    try {
      closeStream = connectStream(relay, runtime);
      await released;
    } finally {
      leader = false;
      closeStream?.();
    }
  }).catch(() => {
    if (!controller.signal.aborted) emit({ type: "error" });
  });
  channel.postMessage({ type: "status-request" });
  return () => {
    controller.abort();
    closeStream?.();
    releaseLock?.();
    channel.close();
  };
}

/**
 * Share one stream per origin: six HTTP/1.1 streams would starve `/api/state`.
 * EventSource retries dropped connections itself; reopen CLOSED streams with
 * backoff because non-200 responses (including restart-time 503s) stop it for good.
 */
export function connectLiveEvents(handlers: LiveEventHandlers, runtime: LiveEventRuntime = browserRuntime) {
  let opened = false;
  let stopped = false;
  const receive = (event: LiveEvent) => {
    if (stopped) return;
    switch (event.type) {
      case "open": {
        const reconnected = opened;
        opened = true;
        handlers.open(reconnected);
        break;
      }
      case "error": handlers.error(); break;
      case "message": handlers.message({ data: event.data }); break;
      case "invalidate": handlers.invalidate(); break;
    }
  };
  const close = runtime.requestLock && runtime.createChannel
    ? connectSharedStream(receive, runtime, runtime.createChannel(coordinationName), runtime.requestLock)
    : connectStream(receive, runtime);
  return () => {
    stopped = true;
    close();
  };
}
