import { Mail } from "lucide-react";
import type { GmailState } from "../../shared/gmail";
import InfoTooltip from "../ui/InfoTooltip";

export type GmailRun = (path: string, body?: unknown) => Promise<unknown>;

function GmailPreference({ id, label, help, checked, disabled, onChange }: {
  id: string; label: string; help?: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  return <div className="gmail-preference">
    <div className="checkbox-label gmail-preference-label">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={help ? `${id}-help` : undefined} onChange={event => onChange(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
      {help && <InfoTooltip label={`About ${label.toLowerCase()}`}>{help}</InfoTooltip>}
    </div>
    {help && <span id={`${id}-help`} className="sr-only">{help}</span>}
  </div>;
}

/** Gmail connection, authorization and employer-reply preferences; shown on Settings and on Employer replies. */
export function GmailConnectionSetup({ data, run, busy }: { data: GmailState; run: GmailRun; busy: boolean }) {
  const fullAccess = data.filterSettingsGranted && data.sendGranted;
  const settings = (changes: Partial<Pick<GmailState, "enabled" | "autoUpdate" | "includeNegative">>) =>
    void run("/api/gmail/settings", { enabled: data.enabled, autoUpdate: data.autoUpdate, ...changes });
  return <section className="panel gmail-panel" aria-labelledby="gmail-connection-heading">
    <div className="section-heading">
      <div><div className="heading-help">
        <h2 id="gmail-connection-heading">Gmail connection</h2>
        <InfoTooltip label="About Gmail checks">Employer-reply checks read mail without sending email, marking messages read, or changing labels. The first check covers the past 90 days.</InfoTooltip>
      </div></div>
      <Mail size={18} aria-hidden="true" />
    </div>
    <div className="panel-body form-stack">
      <p>{data.connected ? `Connected as ${data.account}.` : "Connect Gmail to find interview invitations, assessments and job offers for your saved applications."}</p>
      <p className="small muted">
        Follow-up emails are sent only when you press Send on an application.
        {" "}{fullAccess ? "Gmail sending and filter settings access are authorized." : "Authorize Gmail sending to add permission to send the follow-up emails you approve and to manage filters and basic Gmail settings; your existing connection keeps working until you approve."}
      </p>
      {!data.configured && <details>
        <summary>Set up Google access once <InfoTooltip label="About Google testing mode">Google apps left in Testing generally need reauthorization after seven days. The connection will show when you need to reconnect.</InfoTooltip></summary>
        <ol>
          <li>In <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Google Cloud</a>, select or create your project and enable Gmail API.</li>
          <li>Configure <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a> with yourself as a test user, then create a <strong>Desktop app</strong> OAuth client and download its JSON file.</li>
          <li>Choose that file below, then connect and approve Gmail read, send and basic settings access.</li>
        </ol>
      </details>}
      {!data.connected && <label className="form-stack">Google Desktop OAuth client JSON
        <input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run("/api/gmail/configure", file);
        }} />
      </label>}
      <div className="gmail-actions">
        {data.configured && <button className={`button ${data.connected && fullAccess ? "secondary" : "primary"}`} disabled={busy || data.checking} onClick={() => void run("/api/gmail/connect")}>{data.connected ? fullAccess ? "Reconnect Gmail" : "Authorize Gmail sending" : "Connect Gmail"}</button>}
        {data.connected && <button className="button secondary" disabled={busy || data.checking} onClick={() => void run("/api/gmail/disconnect")}>Disconnect Gmail</button>}
      </div>
      <fieldset className="gmail-preferences">
        <legend>Preferences</legend>
        <GmailPreference id="gmail-enabled" label="Check automatically every 15 minutes, even when Fieldwork is closed"
          checked={data.enabled} disabled={busy} onChange={enabled => settings({ enabled })} />
        <GmailPreference id="gmail-auto-update" label="Automatically update clear application matches"
          help="Interview invitations move applied applications to Interviewing; offers move them to Offer. Assessments add a next action when it is empty. Existing notes, dates and submitted documents stay intact. Ambiguous or older messages need review."
          checked={data.autoUpdate} disabled={busy} onChange={autoUpdate => settings({ autoUpdate })} />
        <GmailPreference id="gmail-include-negative" label="Include negative replies"
          help="Negative replies appear in Employer replies too. With automatic updates on, clear rejections mark applications Rejected after the complete check and hide them from the default Applications view; select the Rejected stage to see them. Unclear outcomes, closed roles and hiring pauses need review."
          checked={data.includeNegative} disabled={busy || data.checking} onChange={includeNegative => settings({ includeNegative })} />
      </fieldset>
    </div>
  </section>;
}
