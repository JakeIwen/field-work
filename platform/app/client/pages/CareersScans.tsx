import DeleteRecord from "../ui/DeleteRecord";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import { api } from "../workspace/api";
import { formatDate } from "../ui/dates";
import React, { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Pause,
  Play,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import type { AppState } from "../../shared/types";
type Props = {
  state: AppState;
  go: (page: string, id?: string) => void;
  mutate: (url: string, body: any, method?: string) => Promise<any>;
};
export default function CareersScans({ state, go, mutate }: Props) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState("");
  const request = useRef(crypto.randomUUID());
  const refresh = () =>
    api("/api/careers-scans", undefined, undefined, { responseType: "response" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw Error(d.error);
        setData(d);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!data?.activeId) return;
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [data?.activeId]);
  const run =
      data?.runs?.find((r: any) => r.id === selected) || data?.runs?.[0],
    active = Boolean(data?.activeId);
  const stamp = (value: string) => formatDate(value, true);
  async function start(mode: string) {
    setBusy(true);
    setError("");
    try {
      const r = await mutate("/api/careers-scans", {
        mode,
        clientRequestId: request.current,
      });
      setSelected(r.id);
      request.current = crypto.randomUUID();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function control(action: string) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/api/careers-scans/${run.id}/${action}`, {});
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="careers-scans">
      <section className="panel">
        <div className="section-heading">
          <div>
            <div className="heading-help">
              <h2>Keep the watchlist’s openings current</h2>
              <InfoTooltip label="About Careers scans">Scans public employer sites, rechecks retained postings, and searches official inventories for new candidates. This is separate from Rescan files. New matches need fit review; saved notes, bookmarks, applications, and documents are preserved. Unsupported or inaccessible boards remain incomplete rather than empty. No applications or messages are sent.</InfoTooltip>
            </div>
            <p className="small muted">
              <strong>{data?.monitored ?? "…"}</strong> monitored employers
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="row-wrap">
            <button
              className="button primary"
              disabled={busy || active || !data?.monitored}
              onClick={() => start("all")}
            >
              <RefreshCw size={16} />
              Scan all monitored companies
            </button>
            <button
              className="button secondary"
              disabled={busy || active || !data?.failedIds?.length}
              onClick={() => start("failed")}
            >
              <RefreshCw size={15} />
              Retry failed companies ({data?.failedIds?.length ?? 0})
            </button>
          </div>
          <p className="tiny muted">
            Last full watchlist attempt:{" "}
            {stamp(
              String(state.scan.lastFullScan || state.scan.timestamp || ""),
            )}
          </p>
          {error && (
            <p className="banner danger" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
      {!data ? (
        <p role="status">Loading scan history…</p>
      ) : !run ? (
        <div className="panel panel-body">
          <h2>No app-launched scans yet</h2>
          <p>
            Last recorded careers scan:{" "}
            {stamp(String(state.scan.timestamp || ""))}. Start a scan to refresh
            the sources.
          </p>
        </div>
      ) : (
        <>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>
                  {run.mode === "all"
                    ? "All monitored companies"
                    : "Retry failed companies"}
                </h2>
                <span className="badge">
                  {String(run.status).replaceAll("_", " ")}
                </span>
                <p className="small muted">
                  Started {stamp(run.startedAt)}
                  {run.completedAt
                    ? ` · Finished ${stamp(run.completedAt)}`
                    : ""}
                </p>
              </div>
              <div className="row-wrap">
                {run.id === data.activeId && (
                  <button
                    className="button secondary"
                    disabled={busy || run.status === "publishing"}
                    onClick={() => control("pause")}
                  >
                    <Pause size={14} />
                    Pause scan
                  </button>
                )}
                {run.status === "interrupted" && (
                  <button
                    className="button secondary"
                    disabled={busy || active}
                    onClick={() => control("resume")}
                  >
                    <Play size={14} />
                    Resume pending companies
                  </button>
                )}
              </div>
            </div>
            <div className="panel-body">
              <p className="careers-progress" role="status">
                {["running", "publishing", "pausing"].includes(run.status) && (
                  <LoaderCircle className="spin" size={16} />
                )}
                <strong>
                  {run.completed} / {run.total}
                </strong>{" "}
                company checks saved
                {run.status === "publishing"
                  ? " · Validating and importing results…"
                  : ""}
              </p>
              {run.error && <p className="banner danger">{run.error}</p>}
              {run.summary && (
                <>
                  <div className="scan-summary">
                    {[
                      ["new", "New candidates"],
                      ["changed", "Changed"],
                      ["reopened", "Reopened"],
                      ["closed", "Confirmed closed"],
                      ["unconfirmed", "Unconfirmed"],
                      ["failed", "Incomplete companies"],
                    ].map(([key, label]) => (
                      <div key={key}>
                        <strong>{run.summary[key]}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <p className="small">
                    {run.summary.retained} retained opportunities ·{" "}
                    {run.summary.seen.toLocaleString()} identities in discovery
                    history
                    <InfoTooltip label="About discovery identities">Seen identities are historical discovery records, not the current openings list.</InfoTooltip>
                  </p>
                </>
              )}
              {run.snapshotPath && (
                <a
                  className="text-button"
                  href={`/api/source?path=${encodeURIComponent(run.snapshotPath + "/README.md")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Scan evidence and limitations <ExternalLink size={13} />
                </a>
              )}
              {run.validation && (
                <details>
                  <summary>Import validation</summary>
                  <p>{run.validation.status}</p>
                  <ul>
                    {run.validation.checks.map((s: string) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
              {run.changes?.length > 0 && (
                <details className="scan-changes">
                  <summary>What changed ({run.changes.length})</summary>
                  {run.changes.map((c: any) => (
                    <div className="scan-change" key={c.id + ":" + c.kind}>
                      <span className="badge">{c.kind}</span>
                      <AppLink
                        className="text-button"
                        go={go} page={"openings"} id={c.id}
                      >
                        {c.company} · {c.title}
                      </AppLink>
                      <small>{c.reason}</small>
                    </div>
                  ))}
                </details>
              )}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Check</th>
                    <th>Inventory</th>
                    <th>Evidence / limitations</th>
                  </tr>
                </thead>
                <tbody>
                  {run.rows.map((r: any) => (
                    <tr key={r.company_id}>
                      <td>
                        <AppLink
                          className="text-button"
                          go={go} page={"companies"} id={r.company_id}
                        >
                          {r.company}
                        </AppLink>
                        <small className="block">
                          {r.checkedAt ? stamp(r.checkedAt) : ""}
                        </small>
                      </td>
                      <td>{r.status === "complete" ? r.result : r.status}</td>
                      <td>{r.inventoryCount ?? "Unknown"}</td>
                      <td>
                        <span className="small">
                          {r.notes || "Waiting for this company’s check."}
                        </span>
                        {r.sources?.length > 0 && (
                          <details>
                            <summary>{r.sources.length} source URLs</summary>
                            {r.sources.map((u: string) => (
                              <a
                                key={u}
                                className="scan-source"
                                href={u}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {u}
                              </a>
                            ))}
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel panel-body">
            <h2>Recent scans</h2>
            <div className="scan-history">
              {data.runs.map((r: any) => (
                <div className="record-with-delete" key={r.id}><button
                  key={r.id}
                  className={`task-row ${r.id === run.id ? "selected" : ""}`}
                  onClick={() => setSelected(r.id)}
                >
                  <span>
                    {stamp(r.startedAt)} ·{" "}
                    {r.mode === "all" ? "Full watchlist" : "Failed companies"}
                    <small>
                      {String(r.status).replaceAll("_", " ")} · {r.completed}/
                      {r.total} checked
                    </small>
                  </span>
                </button><DeleteRecord kind="career_scan" id={r.id} label={`scan ${stamp(r.startedAt)}`} onDeleted={() => void refresh()} /></div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
