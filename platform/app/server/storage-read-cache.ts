/** Reuse file-, clock- and runtime-derived checks only within a synchronous read.
 * Cross-request caching in storage-state-cache covers exclusively Store-derived
 * parts; source edits and deleted/corrupt files must be seen on the next request. */
const scopes = new WeakMap<
  object,
  Map<string, { value: unknown } | { error: unknown }>
>();

export function withReadCache<T>(owner: object, read: () => T): T {
  if (scopes.has(owner)) return read();
  scopes.set(owner, new Map());
  try {
    return read();
  } finally {
    scopes.delete(owner);
  }
}

export function cachedRead<T>(owner: object, key: string, read: () => T): T {
  const cache = scopes.get(owner);
  if (!cache) return read();
  const saved = cache.get(key);
  if (saved) {
    if ("error" in saved) throw saved.error;
    // The key belongs to the calling reader, which always returns the same type.
    return saved.value as T;
  }
  try {
    const value = read();
    cache.set(key, { value });
    return value;
  } catch (error) {
    cache.set(key, { error });
    throw error;
  }
}

export function clearReadCache(owner: object) {
  scopes.get(owner)?.clear();
}
