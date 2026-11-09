import { useState } from "react";
import { LoaderCircle, MailCheck, Send } from "lucide-react";
import {
  isFollowUpAddress,
  type FollowUpVerification,
  type SentFollowUpEmail,
} from "../../shared/follow-up-email";
import { formatDate } from "../ui/dates";
import InfoTooltip from "../ui/InfoTooltip";
import type { FollowUpEmailState } from "./useFollowUpEmail";

export function VerificationNote({ verification }: { verification: FollowUpVerification }) {
  if (verification.status === "matched")
    return <span className="follow-up-verified">Gmail's sent copy matches the draft exactly.</span>;
  return (
    <span className={verification.status === "mismatch" ? "follow-up-mismatch" : "muted"}>
      {verification.status === "mismatch" ? "Gmail's sent copy differs from the draft. " : ""}
      {verification.detail}
    </span>
  );
}

function SentEmail({ sent }: { sent: SentFollowUpEmail }) {
  return (
    <li className="follow-up-sent">
      <p className="small">
        <MailCheck size={14} aria-hidden="true" /> Sent {formatDate(sent.at, true)} to {sent.to}.{" "}
        <VerificationNote verification={sent.verification} />
      </p>
      <details>
        <summary className="small">Sent text</summary>
        <p className="small"><strong>{sent.subject}</strong></p>
        <pre className="follow-up-sent-body">{sent.body}</pre>
      </details>
    </li>
  );
}

export function FollowUpSentList({ sent }: { sent: SentFollowUpEmail[] }) {
  if (!sent.length) return null;
  return <ul className="follow-up-sent-list">{[...sent].reverse().map((entry) => <SentEmail key={entry.id} sent={entry} />)}</ul>;
}

function TestCopy({ f, locked }: { f: FollowUpEmailState; locked: boolean }) {
  const last = f.followUp?.testSends[0];
  const [to, setTo] = useState(() => last?.to ?? "");
  return (
    <details className="follow-up-test">
      <summary className="small">
        Send a test copy
        <InfoTooltip label="About test copies">The test goes only to the email address shown below with the saved text, is checked against Gmail's stored copy, and does not count as your follow-up.</InfoTooltip>
      </summary>
      <div className="follow-up-test-row">
        <input type="email" aria-label="Test copy recipient" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
        <button type="button" className="button secondary" disabled={locked || !isFollowUpAddress(to.trim())} onClick={() => void f.send(to.trim())}>
          {f.busy === "test" ? "Sending…" : "Send test"}
        </button>
      </div>
      {last && (
        <p className="small">
          Last test {formatDate(last.at, true)} to {last.to}: <VerificationNote verification={last.verification} />
        </p>
      )}
    </details>
  );
}

/** Sending is explicit: a confirm step names the recipient and account, and nothing is sent without it. */
export function FollowUpSend({ f, locked }: { f: FollowUpEmailState; locked: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const capability = f.capability;
  const sending = f.followUp?.sending;
  if (sending?.uncertain)
    return (
      <div className="follow-up-uncertain" role="alert">
        <p className="small">{sending.error || "Gmail did not confirm whether this email was sent."} Look for the email to {sending.to} in Gmail's Sent folder, then record what happened.</p>
        <div className="follow-up-actions">
          <button type="button" className="button secondary" disabled={!!f.busy} onClick={() => void f.resolve("sent")}>It was sent</button>
          <button type="button" className="button secondary" disabled={!!f.busy} onClick={() => void f.resolve("not-sent")}>It was not sent</button>
        </div>
      </div>
    );
  if (sending)
    return <p className="small follow-up-progress" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" /> Sending to {sending.to}…</p>;
  if (!capability) return null;
  if (!capability.connected)
    return <p className="small muted">Connect Gmail in Settings to send from Fieldwork. Copy text works without it.</p>;
  if (!capability.sendGranted)
    return (
      <div className="follow-up-authorize">
        <p className="small">Sending needs permission for Fieldwork to send email from {capability.account}. It sends only when you press Send.</p>
        <button type="button" className="button secondary" disabled={!!f.busy} onClick={() => void f.authorize()}>Authorize Gmail sending</button>
      </div>
    );
  const to = f.fields.to.trim();
  const ready = isFollowUpAddress(to) && !!f.fields.subject.trim() && !!f.fields.body.trim();
  return (
    <div className="follow-up-send">
      {confirming ? (
        <div className="follow-up-confirm" role="group" aria-label="Confirm sending">
          <p className="small">Send this email to <strong>{to}</strong> from {capability.account}?{f.dirty ? " Your edits are saved first." : ""}</p>
          <div className="follow-up-actions">
            <button type="button" className="button primary" disabled={locked} onClick={() => void f.send().then((result) => { if (result) setConfirming(false); })}>
              <Send size={14} aria-hidden="true" /> {f.busy === "send" || f.busy === "save" ? "Sending…" : "Send now"}
            </button>
            <button type="button" className="button secondary" disabled={!!f.busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="follow-up-actions">
          <button type="button" className="button primary" disabled={locked || !ready} onClick={() => setConfirming(true)}>
            <Send size={14} aria-hidden="true" /> Send email
          </button>
          {!isFollowUpAddress(to) && <span className="small muted">Add the recipient's email address to send.</span>}
        </div>
      )}
      <TestCopy f={f} locked={locked} />
    </div>
  );
}
