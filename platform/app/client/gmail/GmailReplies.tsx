import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AppState } from "../../shared/types";
import { employerReplyLabels, gmailMessageUrl, isNegativeReply, type EmployerReply, type GmailState } from "../../shared/gmail";
import { api } from "../workspace/api";
import { formatDate } from "../ui/dates";
import { type Go } from "../workspace/workspace-actions";
import AppLink from "../ui/AppLink";
import GmailScanStatus from "./GmailScanStatus";
import { GmailConnectionSetup } from "./GmailConnection";
import { isEarlierEmployerReply } from "../../shared/gmail-attention";
import "./gmail.css";

function ReplyCard({ reply, state, go, review, busy }: { reply: EmployerReply; state: AppState; go: Go; review: () => void; busy: boolean }) {
  return <article className="gmail-reply">
    <div className="gmail-reply-heading"><strong>{employerReplyLabels[reply.kind]}</strong><span className="small muted">{formatDate(reply.receivedAt, true)}</span></div>
    <h3>{reply.subject || "(No subject)"}</h3>
    <p className="small muted">{reply.sender}</p>
    <p className="gmail-excerpt">{reply.excerpt}</p>
    <p className="small">{reply.update ? reply.update.from === reply.update.to ? "Next action updated from this email." : `Application moved from ${reply.update.from} to ${reply.update.to}.` : reply.pendingApplicationId ? "Waiting for the complete check before deciding whether to mark this application rejected." : "Review needed; no automatic application change."}</p>
    <p className="small muted">{reply.reason}</p>
    {isEarlierEmployerReply(reply, state.applications) && <p className="small muted">Earlier correspondence: this predates the saved application or its later closed status.</p>}
    <div className="gmail-actions">
      <a className="button secondary" href={gmailMessageUrl(reply)} target="_blank" rel="noreferrer">Open in Gmail</a>
      {reply.applicationIds.map(id => {
        const application = state.applications.find(a => a.id === id);
        const opening = state.openings.find(o => o.id === application?.openingId);
        return application ? <AppLink key={id} className="button secondary" go={go} page="applications" id={id}
          title={reply.update?.to === "rejected" ? "Rejected applications are hidden by default. Select Rejected on Applications, or open this application." : undefined}>
          {opening?.company ?? application.company ?? "Application"}{reply.applicationIds.length > 1 ? ` · ${opening?.title ?? application.title ?? "Review"}` : " · View application"}
        </AppLink> : null;
      })}
      {!reply.reviewedAt && <button className="button secondary" disabled={busy} onClick={review}>Mark reviewed</button>}
      {reply.reviewedAt && <span className="small muted">Reviewed</span>}
    </div>
  </article>;
}

export default function GmailReplies({ state, page, go, heading = true }: { state: AppState; page: string; go: Go; heading?: boolean }) {
  const [data, setData] = useState<GmailState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const [showNegative, setShowNegative] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const request = useRef(0);
  const refresh = async () => {
    const revision = ++request.current;
    try {
      const value = await api<GmailState>("/api/gmail");
      if (revision === request.current) { setData(value); setError(""); }
    } catch (cause) { if (revision === request.current) setError((cause as Error).message); }
  };
  useEffect(() => { void refresh(); }, [state]);
  useEffect(() => {
    const update = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(update, data?.checking ? 2000 : 30000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); };
  }, [data?.checking]);
  const run = async (path: string, body: unknown = {}) => {
    setBusy(true); setError(""); ++request.current;
    try {
      if (body instanceof File) {
        if (body.size > 100000) throw new Error("Choose the small OAuth client JSON downloaded from Google.");
        try { body = JSON.parse(await body.text()); } catch { throw new Error("That file is not valid JSON."); }
      }
      if (path === "/api/gmail/connect") {
        const result = await api<{ url: string }>(path, body);
        location.assign(result.url);
      } else setData(await api<GmailState>(path, body));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const count = data?.replies.filter(r => !r.reviewedAt && !isNegativeReply(r.kind) && !isEarlierEmployerReply(r, state.applications)).length ?? 0;
  const negativeCount = data?.replies.filter(r => isNegativeReply(r.kind)).length ?? 0;
  const earlierCount = data?.replies.filter(r => isEarlierEmployerReply(r, state.applications)).length ?? 0;
  const visibleReplies = data?.replies.filter(r => (showReviewed || !r.reviewedAt) && (showNegative || !isNegativeReply(r.kind)) && (showEarlier || !isEarlierEmployerReply(r, state.applications))) ?? [];
  const full = page === "replies";
  const settings = page === "settings";
  if (!data) {
    const pending = error ? <div className="panel gmail-panel" role="alert">Gmail: {error} <button className="button secondary" onClick={() => void refresh()}>Retry</button></div>
      : full || settings ? <p role="status" className={settings ? "panel settings-placeholder small muted" : undefined}>Loading Gmail connection…</p> : null;
    return pending;
  }
  const compact = !full && data.connected && count === 0 && !data.checking && !data.hasMore && !data.needsRescan
    && !data.needsNegativeBackfill && Boolean(data.lastCheckedAt) && !error && !data.error;
  const replyActions = <div className="gmail-actions">
    {!full && <AppLink className="button secondary" page="replies" go={go}>Review replies</AppLink>}
    {data.connected && <button className="button secondary" disabled={busy || data.checking || Date.parse(data.retryAt ?? "") > Date.now()} onClick={() => void run("/api/gmail/check", { manual: true })}><RefreshCw size={14} aria-hidden="true" />{data.hasMore ? "Continue check" : "Check now"}</button>}
  </div>;
  return <>
    {(settings || (full && !data.connected)) && <GmailConnectionSetup data={data} run={run} busy={busy} />}
    {(full || data.connected || error) && (compact ? <section className="panel gmail-panel gmail-panel-compact" aria-label="Employer replies">
      <div className="gmail-compact-row">
        {heading && <h2>No employer replies need attention</h2>}
        <GmailScanStatus data={data} compact />
        {replyActions}
      </div>
    </section> : <section className="panel gmail-panel" aria-label="Employer replies">
      <div className="section-heading gmail-reply-heading">
        <div>{heading && <h2>{full ? "Employer replies" : `${count} employer ${count === 1 ? "reply" : "replies"} needing attention`}</h2>}
          <GmailScanStatus data={data} />
        </div>
        {replyActions}
      </div>
      {(error || data.error) && <div className="gmail-error">
        <span role="alert">{error || data.error}</span>
        {!error && data.reconnectRequired && data.configured && <button className="button primary" disabled={busy || data.checking} onClick={() => void run("/api/gmail/connect", { returnTo: window.location.hash })}>Reconnect Gmail</button>}
      </div>}
      {data.needsNegativeBackfill && <p className="small muted panel-body">{data.checking || data.hasMore ? "This check includes negative replies from the past 90 days. Rejections are applied after all pages finish." : "The next check will also look for negative replies from the past 90 days."}</p>}
      {data.retryAt && !data.checking && <p className="small muted panel-body">Next check available {formatDate(data.retryAt, true)}.</p>}
      {full && <div className="panel-body form-stack">
        <label className="checkbox-label"><input type="checkbox" checked={showReviewed} onChange={event => setShowReviewed(event.target.checked)} />Show reviewed replies</label>
        {negativeCount > 0 && <label className="checkbox-label"><input type="checkbox" checked={showNegative} onChange={event => setShowNegative(event.target.checked)} />Show negative replies ({negativeCount})</label>}
        {earlierCount > 0 && <label className="checkbox-label"><input type="checkbox" checked={showEarlier} onChange={event => setShowEarlier(event.target.checked)} />Show earlier replies ({earlierCount})</label>}
        {visibleReplies.map(reply => <ReplyCard key={reply.id} reply={reply} state={state} go={go} busy={busy} review={() => void run(`/api/gmail/replies/${encodeURIComponent(reply.id)}/review`)} />)}
        {!visibleReplies.length && <p className="muted">{data.connected ? data.checking || data.hasMore || data.needsRescan || data.error ? "No replies to show yet; email coverage is incomplete." : "No unreviewed positive replies detected. Unusual wording can still need a check in Gmail." : "Connect Gmail above to start checking."}</p>}
      </div>}
    </section>)}
    {full && data.connected && <details className="gmail-connection-settings"><summary>Gmail connection and preferences</summary><GmailConnectionSetup data={data} run={run} busy={busy} /></details>}
  </>;
}
