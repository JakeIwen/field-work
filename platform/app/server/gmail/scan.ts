import type { GmailScan } from "../../shared/gmail.js";
import type { GmailMessage, GmailPage, GmailReader } from "./api.js";
import { GmailError } from "./api.js";
import {
  gmailContextApplicationIds,
  matchEmployerReply,
  needsGmailThreadContext,
} from "./matching.js";

export const gmailScanVersion = 2;
export const gmailInitialWindowMs = 90 * 86_400_000;
export const gmailOverlapMs = 86_400_000;

export const gmailQuery = (since: number, through: number) =>
  `after:${Math.floor(since / 1000)} before:${Math.floor(through / 1000) + 1} -in:sent -in:drafts -in:spam -in:trash`;

export function startGmailWindow(
  scan: GmailScan,
  includeNegative: boolean,
  at: number,
  initialWindowMs = gmailInitialWindowMs,
  overlapMs = gmailOverlapMs,
) {
  if (scan.pending?.scanVersion === gmailScanVersion) return scan.pending;
  const through = new Date(at).toISOString();
  const since =
    scan.lastCheckedAt &&
    scan.lastScanVersion === gmailScanVersion &&
    (!includeNegative || scan.lastIncludedNegative)
      ? Date.parse(scan.lastCheckedAt) - overlapMs
      : at - initialWindowMs;
  scan.pending = {
    query: gmailQuery(since, at),
    through,
    checked: 0,
    includeNegative,
    scanVersion: gmailScanVersion,
    seenPageTokens: [],
  };
  return scan.pending;
}

export function recordGmailPage(
  pending: NonNullable<GmailScan["pending"]>,
  result: GmailPage,
  seenMessageIds: Set<string>,
) {
  const token = result.nextPageToken;
  if (
    token &&
    (token === pending.pageToken || pending.seenPageTokens?.includes(token))
  )
    throw new GmailError(
      "Gmail repeated a page cursor. The check is incomplete; retry later.",
    );
  if (result.ids.some((id) => seenMessageIds.has(id)))
    throw new GmailError(
      "Gmail repeated a page. The check is incomplete; retry later.",
    );
  if (pending.pageToken) {
    const tokens = pending.seenPageTokens ?? [];
    if (!tokens.includes(pending.pageToken)) tokens.push(pending.pageToken);
    pending.seenPageTokens = tokens;
  }
}

type MatchArguments = {
  message: GmailMessage;
  account: string;
  includeNegative: boolean;
  applications: Parameters<typeof matchEmployerReply>[2];
  openings: Parameters<typeof matchEmployerReply>[3];
  reader: GmailReader;
  threadCache: Map<string, Promise<GmailMessage[]>>;
};

export async function matchGmailMessage(args: MatchArguments) {
  const { message, account, applications, openings, includeNegative } = args;
  const direct = matchEmployerReply(
    message,
    account,
    applications,
    openings,
    includeNegative,
  );
  if (
    direct?.reply.applicationIds.length ||
    !args.reader.thread ||
    !needsGmailThreadContext(message)
  )
    return direct;
  let lookup = args.threadCache.get(message.threadId);
  if (!lookup) {
    lookup = args.reader.thread(message.threadId);
    args.threadCache.set(message.threadId, lookup);
  }
  const applicationIds = [
    ...new Set(
      (await lookup)
        .filter(
          (candidate) =>
            candidate.id !== message.id &&
            candidate.receivedAt <= message.receivedAt,
        )
        .flatMap((candidate) =>
          gmailContextApplicationIds(
            candidate,
            account,
            applications,
            openings,
          ),
        ),
    ),
  ];
  return applicationIds.length
    ? matchEmployerReply(
        message,
        account,
        applications,
        openings,
        includeNegative,
        { applicationIds },
      )
    : direct;
}
