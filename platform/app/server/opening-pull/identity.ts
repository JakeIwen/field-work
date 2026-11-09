import { greenhouseAliasReferences } from "../../shared/opening-aliases.js";
import type { Opening } from "../../shared/types.js";
import { samePostingUrls } from "../job-posting.js";
import type { Store } from "../storage.js";
import {
  type PullCard as GreenhouseCard,
  type PullPosting as GreenhousePosting,
} from "./contract.js";

export function greenhousePublicId(url: string) {
  try {
    const u = new URL(url);
    return (
      u.searchParams.get("gh_jid") ||
      (/\.(?:eu\.)?greenhouse\.io$/.test(u.hostname)
        ? u.pathname.match(/\/jobs\/(\d+)/)?.[1]
        : undefined)
    );
  } catch {
    return undefined;
  }
}
export function existingGreenhouseOpening(
  store: Store,
  card: GreenhouseCard,
  posting?: GreenhousePosting,
  openings: Opening[] = [
    ...store.list("cache_opening"),
    ...store.list("custom_opening"),
  ],
) {
  const ids = new Set(posting?.aliases ?? [card.id]);
  // Raw records include dismissed/closed entries and records merged in the list view.
  return openings.find((o) => {
    if (samePostingUrls(o.url, card.url)) return true;
    // Legacy or invalid URLs fall through to the alias checks.
    const aliases = greenhouseAliasReferences(o);
    const candidates = [
      greenhousePublicId(o.url),
      ...aliases.publicIds,
      ...aliases.urls.map(greenhousePublicId),
    ];
    if (candidates.some((id) => id != null && ids.has(String(id)))) return true;
    const boardMatch =
      o.greenhouse?.board === card.board ||
      [o.url, ...(o.sources ?? [])].some((url: string) => {
        try {
          const u = new URL(url);
          return (
            /\.greenhouse\.io$/.test(u.hostname) &&
            (u.pathname.startsWith(`/${card.board}/jobs/`) ||
              u.pathname.startsWith(`/v1/boards/${card.board}/jobs`))
          );
        } catch {
          return false;
        }
      });
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/\b(inc|llc|ltd|corporation|corp)\b/g, "")
        .replace(/[^a-z0-9]/g, "");
    const employerMatch =
      boardMatch ||
      (o.company && normalize(o.company) === normalize(card.company));
    return Boolean(
      posting?.raw.internal_job_id != null &&
      employerMatch &&
      String(o.greenhouse?.internalJobId ?? o.internalJobId) ===
        String(posting.raw.internal_job_id),
    );
  });
}
