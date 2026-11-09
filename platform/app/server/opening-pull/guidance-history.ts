import { type GreenhouseGuidanceHistoryEntry } from "../../shared/greenhouse-guidance.js";
import { tunable } from "../tunables.js";
import { MissingRecordError, now, sha256, type Store } from "../storage.js";

export const normalizeGreenhouseGuidanceInstructions = (instructions: string) =>
  instructions.replace(/\r\n/g, "\n").trim();

export function greenhouseGuidanceHistory(store: Store) {
  return store
    .list("greenhouse_guidance_history")
    .sort(
      (a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id),
    );
}

export function rememberGreenhouseGuidance(
  store: Store,
  instructions: string,
  lastUsedAt = now(),
  createdAt = lastUsedAt,
): GreenhouseGuidanceHistoryEntry | undefined {
  instructions = normalizeGreenhouseGuidanceInstructions(instructions);
  if (!instructions) return;
  const id = sha256(instructions);
  const old = store.get("greenhouse_guidance_history", id);
  const entry = store.put("greenhouse_guidance_history", id, {
    id,
    instructions,
    createdAt: old?.createdAt ?? createdAt,
    lastUsedAt,
  });
  for (const excess of greenhouseGuidanceHistory(store).slice(
    tunable(store, "greenhouse.guidanceHistoryEntries"),
  ))
    store.remove("greenhouse_guidance_history", excess.id);
  return entry;
}

export function deleteGreenhouseGuidanceHistory(store: Store, id: string) {
  if (!store.get("greenhouse_guidance_history", id))
    throw new MissingRecordError(
      404,
      "greenhouse_guidance_history",
      id,
      "Pull instruction history entry not found",
    );
  store.remove("greenhouse_guidance_history", id);
  return { deleted: true };
}
