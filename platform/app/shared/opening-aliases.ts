import type { Opening } from "./types.js";

/** Decode the saved Greenhouse alias representations; URL identity policy belongs to callers. */
export function greenhouseAliasReferences(opening: Partial<Opening>) {
  const publicIds = [
    opening.greenhouse?.publicId,
    ...(opening.greenhouse?.aliases ?? []),
  ].filter((id): id is string => !!id);
  const urls: string[] = [];
  for (const alias of opening.greenhouseAliases ?? []) {
    if (typeof alias === "string") {
      if (/^\d+$/.test(alias)) publicIds.push(alias);
      else urls.push(alias);
    } else {
      for (const id of [alias.publicJobId, alias.id, alias.jobId])
        if (id) publicIds.push(String(id));
      urls.push(...(alias.urls ?? []), ...(alias.url ? [alias.url] : []));
    }
  }
  return { publicIds, urls };
}
