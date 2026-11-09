type Waiter = {resolve: () => void; reject: (error: unknown) => void};

/** One request in flight. Calls during it share the next fresh read, so a
 * mutation never settles against an older response already in flight. */
export function singleFlightRefresh(load: () => Promise<void>): () => Promise<void> {
  let active = false;
  let pending: Waiter[] = [];
  async function run(waiters: Waiter[]) {
    let failure: unknown;
    let failed = false;
    try {await load();} catch (error) {failure = error; failed = true;}
    const next = pending;
    pending = [];
    if (next.length) void run(next);
    else active = false;
    for (const waiter of waiters) failed ? waiter.reject(failure) : waiter.resolve();
  }
  return () => new Promise<void>((resolve, reject) => {
    const waiter = {resolve, reject};
    if (active) pending.push(waiter);
    else {active = true; void run([waiter]);}
  });
}
