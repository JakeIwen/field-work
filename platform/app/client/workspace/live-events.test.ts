import test from "node:test";
import assert from "node:assert/strict";
import { connectLiveEvents, type LiveEventHandlers, type LiveEventRuntime } from "./live-events";

class FakeSource {
  readyState = 0;
  closed = false;
  listeners: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  namedListeners = new Map<string, () => void>();
  addEventListener(name: string, listener: () => void) { this.listeners.push(name); this.namedListeners.set(name, listener); }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  fail(readyState: number) { this.readyState = readyState; this.onerror?.(new Event("error")); }
  message(data: string) { this.onmessage?.(new MessageEvent("message", { data })); }
  invalidate(name: string) { this.namedListeners.get(name)?.(); }
}

function fakeRuntime() {
  const sources: FakeSource[] = [];
  const pending: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const runtime: LiveEventRuntime = {
    create: () => { const source = new FakeSource(); sources.push(source); return source; },
    schedule: (run, ms) => { const entry = { run, ms, cancelled: false }; pending.push(entry); return entry; },
    cancel: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
  };
  return { runtime, sources, pending };
}

type LiveChannel = ReturnType<NonNullable<LiveEventRuntime["createChannel"]>>;
type FakeChannel = LiveChannel & { name: string; closed: boolean };

class ChannelBus {
  channels: FakeChannel[] = [];
  deliveries: (() => void)[] = [];
  create = (name: string): FakeChannel => {
    const channel: FakeChannel = {
      name, closed: false, onmessage: null,
      postMessage: (message) => {
        assert.equal(channel.closed, false, "cannot send on a closed channel");
        for (const peer of this.channels) {
          if (peer === channel || peer.closed || peer.name !== name) continue;
          const data = structuredClone(message);
          this.deliveries.push(() => { if (!peer.closed) peer.onmessage?.(new MessageEvent("message", { data })); });
        }
      },
      close: () => { channel.closed = true; },
    };
    this.channels.push(channel);
    return channel;
  };
  flush() { while (this.deliveries.length) this.deliveries.shift()?.(); }
}

class FakeLocks {
  active = false;
  requests: { name: string; signal: AbortSignal; started: boolean; aborted: boolean }[] = [];
  queue: (() => void)[] = [];
  request: NonNullable<LiveEventRuntime["requestLock"]> = (name, signal, hold) => new Promise((resolve, reject) => {
    const entry = { name, signal, started: false, aborted: false };
    this.requests.push(entry);
    const abort = () => { entry.aborted = true; reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.queue.push(() => {
      signal.removeEventListener("abort", abort);
      if (entry.aborted) { this.advance(); return; }
      this.active = true;
      entry.started = true;
      void Promise.resolve().then(hold).then(resolve, reject).finally(() => {
        this.active = false;
        this.advance();
      });
    });
    this.advance();
  });
  advance() { if (!this.active) this.queue.shift()?.(); }
}

function fakeTab(bus: ChannelBus, locks: FakeLocks) {
  const fixture = fakeRuntime();
  const events = { opens: [] as boolean[], errors: 0, messages: [] as string[], invalidations: 0 };
  const handlers: LiveEventHandlers = {
    open: (reconnected) => events.opens.push(reconnected),
    error: () => events.errors++,
    message: ({ data }) => events.messages.push(data),
    invalidate: () => events.invalidations++,
  };
  const stop = connectLiveEvents(handlers, { ...fixture.runtime, requestLock: locks.request, createChannel: bus.create });
  return { ...fixture, events, stop };
}

async function settle(bus: ChannelBus) {
  // Lock callbacks run asynchronously, and channel messages are never delivered to their sender.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  bus.flush();
}

test("a stream the browser closes after a restart reopens with backoff and refreshes once reconnected", () => {
  const { runtime, sources, pending } = fakeRuntime();
  const opens: boolean[] = [];
  let errors = 0;
  const stop = connectLiveEvents({ open: (reconnected) => opens.push(reconnected), error: () => errors++, message: () => {}, invalidate: () => {} }, runtime);
  assert.deepEqual(sources[0].listeners, ["change", "state", "invalidate", "invalidation", "task", "agent"]);
  sources[0].open();
  // A dropped connection the browser is still retrying (CONNECTING) needs no help.
  sources[0].fail(0);
  assert.equal(pending.length, 0);
  // The companion answers 503 while the backend restarts: EventSource closes for good.
  sources[0].fail(2);
  sources[0].onerror?.(new Event("error"));
  assert.deepEqual(pending.map((entry) => entry.ms), [1000]);
  pending[0].run();
  sources[1].fail(2);
  assert.deepEqual(pending.map((entry) => entry.ms), [1000, 2000]);
  pending[1].run();
  sources[2].open();
  assert.deepEqual(opens, [false, true]);
  assert.equal(errors, 4);
  // A later failure starts the backoff again from one second.
  sources[2].fail(2);
  assert.equal(pending[2].ms, 1000);
  stop();
  assert.equal(pending[2].cancelled, true);
  assert.equal(sources[2].closed, true);
});

test("closing the page's stream stops reconnecting", () => {
  const { runtime, sources, pending } = fakeRuntime();
  const stop = connectLiveEvents({ open: () => {}, error: () => {}, message: () => {}, invalidate: () => {} }, runtime);
  stop();
  sources[0].fail(2);
  assert.equal(pending.length, 0);
  assert.equal(sources.length, 1);
});

test("three tabs share one stream and relay every event to the followers", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const tabs = Array.from({ length: 3 }, () => fakeTab(bus, locks));
  await settle(bus);
  assert.deepEqual(tabs.map((tab) => tab.sources.length), [1, 0, 0]);
  assert.deepEqual(locks.requests.map((request) => request.name), Array(3).fill("fieldwork-live-events"));
  const source = tabs[0].sources[0];
  source.open();
  source.message('{"type":"reindex-progress","progress":{"current":3}}');
  source.listeners.forEach((name) => source.invalidate(name));
  bus.flush();
  for (const tab of tabs) {
    assert.deepEqual(tab.events.opens, [false]);
    assert.deepEqual(tab.events.messages, ['{"type":"reindex-progress","progress":{"current":3}}']);
    assert.equal(tab.events.invalidations, 6);
  }
  const previousErrors = tabs.map((tab) => tab.events.errors);
  source.fail(0);
  bus.flush();
  tabs.forEach((tab, index) => assert.equal(tab.events.errors, previousErrors[index] + 1));
  assert.equal(tabs[0].pending.length, 0);
  source.open();
  bus.flush();
  tabs.forEach((tab) => assert.deepEqual(tab.events.opens, [false, true]));
  tabs.forEach((tab) => tab.stop());
  await settle(bus);
});

test("leader cleanup releases the lock and a follower opens one replacement stream as a reconnect", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const tabs = Array.from({ length: 3 }, () => fakeTab(bus, locks));
  await settle(bus);
  tabs[0].sources[0].open();
  bus.flush();
  tabs[0].stop();
  assert.equal(tabs[0].sources[0].closed, true);
  assert.equal(bus.channels[0].closed, true);
  await settle(bus);
  assert.deepEqual(tabs.map((tab) => tab.sources.length), [1, 1, 0]);
  assert.equal(tabs.flatMap((tab) => tab.sources).filter((source) => !source.closed).length, 1);
  tabs[1].sources[0].open();
  bus.flush();
  assert.deepEqual(tabs[0].events.opens, [false]);
  assert.deepEqual(tabs[1].events.opens, [false, true]);
  assert.deepEqual(tabs[2].events.opens, [false, true]);
  tabs[1].stop();
  tabs[2].stop();
  await settle(bus);
});

test("a tab joining a still-connecting leader waits for its first outcome instead of reporting disconnected", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks);
  await settle(bus);
  const joined = fakeTab(bus, locks);
  await settle(bus);
  assert.equal(joined.events.errors, 0);
  assert.deepEqual(joined.events.opens, []);
  leader.sources[0].open();
  bus.flush();
  assert.deepEqual(joined.events.opens, [false]);
  assert.equal(joined.sources.length, 0);
  [leader, joined].forEach((tab) => tab.stop());
  await settle(bus);
});

test("joining tabs learn connected or retrying status without reopening existing tabs", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks);
  await settle(bus);
  leader.sources[0].open();
  const joined = fakeTab(bus, locks);
  await settle(bus);
  assert.deepEqual(joined.events.opens, [false]);
  assert.equal(joined.events.errors, 0);
  assert.deepEqual(leader.events.opens, [false]);
  leader.sources[0].fail(2);
  bus.flush();
  const retrying = fakeTab(bus, locks);
  await settle(bus);
  assert.deepEqual(retrying.events.opens, []);
  assert.equal(retrying.events.errors, 1);
  assert.equal(joined.events.errors, 1);
  assert.equal(leader.events.errors, 1);
  leader.pending[0].run();
  leader.sources[1].open();
  bus.flush();
  assert.deepEqual(leader.events.opens, [false, true]);
  assert.deepEqual(joined.events.opens, [false, true]);
  assert.deepEqual(retrying.events.opens, [false]);
  [leader, joined, retrying].forEach((tab) => tab.stop());
  await settle(bus);
});

test("queued tab cleanup aborts its lock request, closes its channel and ignores pending deliveries", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks), queued = fakeTab(bus, locks);
  await settle(bus);
  const before = structuredClone(queued.events);
  const receive = bus.channels[1].onmessage;
  leader.sources[0].open();
  queued.stop();
  assert.equal(locks.requests[1].signal.aborted, true);
  assert.equal(locks.requests[1].aborted, true);
  assert.equal(bus.channels[1].closed, true);
  receive?.(new MessageEvent("message", { data: { type: "open" } }));
  receive?.(new MessageEvent("message", { data: { type: "error" } }));
  receive?.(new MessageEvent("message", { data: { type: "message", data: "late" } }));
  receive?.(new MessageEvent("message", { data: { type: "invalidate" } }));
  bus.flush();
  assert.deepEqual(queued.events, before);
  leader.stop();
  await settle(bus);
  assert.equal(queued.sources.length, 0);
  assert.equal(locks.active, false);
});

test("cleanup cancels the leader's retry and ignores every late source callback", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks), follower = fakeTab(bus, locks);
  await settle(bus);
  leader.sources[0].open();
  leader.sources[0].fail(2);
  bus.flush();
  const before = structuredClone(leader.events);
  leader.stop();
  assert.equal(leader.pending[0].cancelled, true);
  leader.pending[0].run();
  leader.sources[0].open();
  leader.sources[0].fail(2);
  leader.sources[0].message("late");
  leader.sources[0].invalidate("change");
  assert.deepEqual(leader.events, before);
  assert.equal(leader.sources.length, 1);
  await settle(bus);
  assert.equal(follower.sources.length, 1);
  follower.sources[0].open();
  bus.flush();
  assert.deepEqual(follower.events.opens, [false, true]);
  follower.stop();
  await settle(bus);
});

test("the shared leader retains capped backoff, resets after open, and ignores replaced sources", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks), follower = fakeTab(bus, locks);
  await settle(bus);
  leader.sources[0].open();
  for (let index = 0; index < 7; index++) {
    leader.sources[index].fail(2);
    leader.pending[index].run();
  }
  assert.deepEqual(leader.pending.map((retry) => retry.ms), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  leader.sources[7].open();
  bus.flush();
  const before = structuredClone(leader.events);
  leader.sources[0].open();
  leader.sources[0].fail(2);
  leader.sources[0].message("stale");
  leader.sources[0].invalidate("change");
  bus.flush();
  assert.deepEqual(leader.events, before);
  assert.deepEqual(follower.events.opens, [false, true]);
  leader.sources[7].fail(2);
  assert.equal(leader.pending[7].ms, 1000);
  [leader, follower].forEach((tab) => tab.stop());
  await settle(bus);
});

test("fallback uses separate reconnecting streams when either coordination API is unavailable", () => {
  for (const missing of ["requestLock", "createChannel"] as const) {
    const bus = new ChannelBus(), locks = new FakeLocks();
    const tabs = Array.from({ length: 2 }, () => {
      const fixture = fakeRuntime();
      const runtime = { ...fixture.runtime, requestLock: locks.request, createChannel: bus.create, [missing]: undefined };
      const opens: boolean[] = [];
      const stop = connectLiveEvents({ open: (value) => opens.push(value), error: () => {}, message: () => {}, invalidate: () => {} }, runtime);
      return { ...fixture, opens, stop };
    });
    for (const tab of tabs) {
      tab.sources[0].open();
      tab.sources[0].fail(2);
      assert.equal(tab.pending[0].ms, 1000);
      tab.pending[0].run();
      tab.sources[1].open();
      assert.deepEqual(tab.opens, [false, true]);
      tab.stop();
    }
    assert.equal(bus.channels.length, 0);
    assert.equal(locks.requests.length, 0);
  }
});

test("a late status reply cannot duplicate an open already relayed to the joining tab", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const leader = fakeTab(bus, locks);
  await settle(bus);
  leader.sources[0].open();
  const joined = fakeTab(bus, locks);
  leader.sources[0].fail(0);
  leader.sources[0].open();
  await settle(bus);
  assert.deepEqual(joined.events.opens, [false]);
  assert.deepEqual(leader.events.opens, [false, true]);
  [leader, joined].forEach((tab) => tab.stop());
  await settle(bus);
});

test("cleanup before the lock callback runs never creates a stream", async () => {
  const bus = new ChannelBus(), locks = new FakeLocks();
  const tab = fakeTab(bus, locks);
  tab.stop();
  await settle(bus);
  assert.equal(tab.sources.length, 0);
  assert.equal(locks.active, false);
  assert.deepEqual(tab.events, { opens: [], errors: 0, messages: [], invalidations: 0 });
});
