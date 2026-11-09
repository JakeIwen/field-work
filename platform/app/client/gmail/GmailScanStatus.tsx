import { FIELDWORK_TIMEZONE } from "../../shared/timezone";
import type { GmailState } from "../../shared/gmail";
import InfoTooltip from "../ui/InfoTooltip";
import { formatDate } from "../ui/dates";

function formatTime(value?: string) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: FIELDWORK_TIMEZONE, timeStyle: "short" }).format(date);
  } catch {
    return value;
  }
}

export default function GmailScanStatus({ data, compact = false }: { data: GmailState; compact?: boolean }) {
  const progress = data.checked ? ` · ${data.checked} messages checked` : "";
  const status = data.checking
    ? `Checking Gmail${progress}…`
    : data.error
      ? "Email check needs attention. Coverage is incomplete."
      : data.hasMore
        ? `Check in progress${progress}. ${data.enabled ? "Remaining mail will be checked automatically." : "Choose Continue check to finish."}`
        : data.needsRescan
          ? "A broader check of the past 90 days is pending."
          : data.lastCheckedAt
            ? `Last completed check ${formatDate(data.lastCheckedAt, true)}`
            : "No completed Gmail check yet.";
  if (compact) {
    const help = [
      "Checks include archived mail and messages that skip the inbox.",
      data.nextCheckAt ? `Next automatic check ${formatDate(data.nextCheckAt, true)}.` : undefined,
      data.retryAt ? `Next manual check available ${formatDate(data.retryAt, true)}.` : undefined,
      !data.enabled ? "Automatic email checks are off." : undefined,
    ].filter(Boolean).join("\n");
    return <div className="gmail-scan-status compact">
      <div className="gmail-scan-primary">
        <p role="status">checked {formatTime(data.lastCheckedAt)}</p>
        <InfoTooltip label="About Gmail coverage">{help}</InfoTooltip>
      </div>
    </div>;
  }
  return <div className="gmail-scan-status">
    <div className="gmail-scan-primary">
      <p role="status">{status}</p>
      <InfoTooltip label="About Gmail coverage">Checks include archived mail and messages that skip the inbox.</InfoTooltip>
    </div>
    {!data.checking && data.nextCheckAt && <p className="small muted">Next automatic check {formatDate(data.nextCheckAt, true)}.</p>}
    {!data.enabled && <p className="small muted">Automatic email checks are off.</p>}
  </div>;
}
