export type OpeningValidation = {
  id: string;
  url: string;
  status: "open" | "closed" | "unknown";
  checkedAt: string;
  reason: string;
  sourceUrl?: string;
  confirmedStatus?: "open" | "closed";
  confirmedAt?: string;
  evidenceHashes: string[];
  runId: string;
  visibilityChange?: "hidden" | "restored";
};
type Opening = {
  postingStatus?: string;
  retained?: unknown;
  lastCheckedAt?: unknown;
  last_confirmed_open?: string | null;
  closedAt?: unknown;
  validation?: OpeningValidation;
};
export function openingAvailability(o: Opening): "open" | "closed" | "unknown" {
  const v = o.validation;
  const sourceStatus =
    o.postingStatus === "closed"
      ? "closed"
      : /^(open|confirmed open at last scan)$/.test(o.postingStatus || "")
        ? "open"
        : "unknown";
  const sourceDate = String(
    o.lastCheckedAt ||
      (sourceStatus === "closed" ? o.closedAt : o.last_confirmed_open) ||
      "",
  );
  if (
    v?.confirmedStatus &&
    !(
      sourceStatus !== "unknown" &&
      Date.parse(sourceDate) > Date.parse(v.confirmedAt || "")
    )
  )
    return v.confirmedStatus;
  return sourceStatus;
}
export const isClosedOpening = (o: Opening) =>
  openingAvailability(o) === "closed";
export const isActiveOpening = (o: Opening) =>
  !isClosedOpening(o) &&
  (o.retained !== false ||
    (o.validation?.confirmedStatus === "open" &&
      openingAvailability(o) === "open"));
export function openingVisibleInList(
  o: Opening,
  filters: { closed: boolean; history: boolean },
) {
  return isClosedOpening(o)
    ? filters.closed
    : filters.history || isActiveOpening(o);
}
/** Shared by the form-inspection error and the client, which then omits "continue with Generate Docs". */
export const postingGoneNotice = "no longer has this posting";
export const validationLabel = (status: string) =>
  status === "open"
    ? "Confirmed open"
    : status === "closed"
      ? "Closed / removed"
      : "Could not verify";
