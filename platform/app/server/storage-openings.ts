import type { Store } from "./storage.js";
import type { Records } from "./records.js";
import type { Opening } from "../shared/types.js";
import { canonicalPosting, samePostingUrls } from "./job-posting.js";

export const openingRecordKinds = [
  "cache_opening",
  "custom_opening",
  "opening_validation",
] as const satisfies readonly (keyof Records)[];

export function readOpenings(store: Store): Opening[] {
  const rows = new Map(store.list("cache_opening").map((o) => [o.id, o]));
  const byPosting = new Map<string, Set<Opening>>();
  const postingKeys = new WeakMap<Opening, string>();
  const index = (row: Opening, key: string | undefined) => {
    if (key === undefined) return;
    const matches = byPosting.get(key) ?? new Set<Opening>();
    matches.add(row);
    byPosting.set(key, matches);
    postingKeys.set(row, key);
  };
  for (const row of rows.values()) index(row, postingKey(row.url));
  for (const o of store.list("custom_opening")) {
    const key = postingKey(o.url);
    // Each bucket follows rows' insertion order, including earlier custom rows.
    const source =
      rows.get(o.id) ??
      (key === undefined
        ? undefined
        : byPosting.get(key)?.values().next().value);
    const sourceKey = source && postingKeys.get(source);
    if (source) {
      rows.delete(source.id);
      if (sourceKey !== undefined) byPosting.get(sourceKey)?.delete(source);
    }
    const newerSource =
      source &&
      Date.parse(source.lastCheckedAt ?? source.sourceDate ?? "") >
        Date.parse(o.lastCheckedAt ?? o.sourceDate ?? "");
    const merged: Opening = {
      ...o,
      ...(newerSource ? source : {}),
      id: o.id,
      company_id: o.company_id,
      company: o.company,
      personalOpening: true,
      // The company contact overlay is authoritative independently of vacancy refresh.
      contactInfo: o.contactInfo ?? source?.contactInfo,
      contact: o.contact ?? source?.contact,
    };
    rows.set(o.id, merged);
    index(merged, newerSource ? sourceKey : key);
  }
  const validations = new Map(
    store.list("opening_validation").map((v) => [v.id, v]),
  );
  return [...rows.values()].map((o) => {
    const validation = validations.get(o.id);
    // Old stored JSON may retain retired fields; reads must not republish them.
    const record = { ...o };
    delete record["priority"];
    return {
      ...record,
      validation:
        validation && samePostingUrls(validation.url, o.url)
          ? validation
          : undefined,
    };
  });
}

function postingKey(url: string) {
  try {
    return canonicalPosting(url);
  } catch {
    // Invalid URLs never matched in samePostingUrls, even when both were equal.
    return undefined;
  }
}
