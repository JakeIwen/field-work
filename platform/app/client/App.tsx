import { tunableValue } from "../shared/tunables";
import { createStateRefreshCadence } from "./workspace/state-refresh-cadence";
import { FIELDWORK_TIMEZONE } from "../shared/timezone";
import ThemeSwitch from "./appearance/ThemeSwitch";
import ThemeEditorButton from "./appearance/ThemeEditorButton";
import ReloadAppButton from "./app-reload/ReloadAppButton";
import AppLink from "./ui/AppLink";
import { openingErrorMessage } from "../shared/opening-error";
import { rescanMessage, type RescanSummary } from "../shared/rescan-summary";
import { rescanProgressLabel, type RescanProgress } from "../shared/rescan-progress";
import { ValidateOpeningsButton, OpeningValidationProgress } from "./openings/OpeningValidation";
import RescanProblems from "./settings/RescanProblems";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, LoaderCircle, Menu, Settings2, X, AlertTriangle } from "lucide-react";
import type { AppState } from "../shared/types";
import { setCsrf, api } from "./workspace/api";
import { entityUrl } from "./shell/entity-url";
import { formatDate } from "./ui/dates";
import type { Go, Mutate } from "./workspace/workspace-actions";
import type { Context } from "./agents/task-context";
import { hasModifier, isTypingTarget } from "./shell/keys";
import "./shell/shell.css";
import "./ui/delete-record.css";
import DevBadge from "./shell/DevBadge";
import ErrorNotice from "./ui/ErrorNotice";
import InfoTooltip from "./ui/InfoTooltip";
import { Empty } from "./ui/Empty";
import { SearchBox } from "./ui/SearchBox";
import { WorkspaceProvider } from "./workspace/workspace";
import { connectLiveEvents } from "./workspace/live-events";
import { syncSavedAppearance } from "./appearance/palette";
import { goKeys, pages, type PageEntry } from "./shell/navigation";
import { ShortcutHelp } from "./shell/ShortcutHelp";
import { Toast } from "./shell/Toast";
import { useNotices } from "./shell/useNotices";
import { usePreparationNotices } from "./preparation/usePreparationNotices";
import { AppPageWithReplies } from "./shell/AppPage";
import { NavigationCount } from "./shell/NavigationCount";

export { pages } from "./shell/navigation";
export function App() {
  const [rescanResult, setRescanResult] = useState<RescanSummary | null>(null);
  const [rescanProgress, setRescanProgress] = useState<RescanProgress | null>(null);
  const [rescanPending, setRescanPending] = useState(false);
  const [visibleOpeningCount, setVisibleOpeningCount] = useState<number | null>(null);
  const rescanEventRevision = useRef(0);
  // A failed state refresh is cleared by the next successful one; action errors stay until dismissed.
  const stateError = useRef("");
  const rescanning = rescanPending || !!rescanProgress;
  const [state, setState] = useState<AppState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(true);
  const [route, setRoute] = useState(() => location.hash.slice(1).split("/")),
    [mobile, setMobile] = useState(false),
    [narrow, setNarrow] = useState(innerWidth <= 760),
    [search, setSearch] = useState(""),
    [help, setHelp] = useState(false);
  const mobileRef = useRef(false);
  mobileRef.current = mobile;
  const helpRef = useRef(false);
  helpRef.current = help;
  const settingsRef = useRef(state?.settings);
  settingsRef.current = state?.settings;
  const { notices, notify, closeNotice } = useNotices(tunableValue(state?.settings ?? {}, "browser.noticeStack"));
  usePreparationNotices(state, notify);
  const [agentContext, setAgentContext] = useState<Context>({
    documentIds: [],
  });
  useEffect(() => {
    const resize = () => setNarrow(innerWidth <= 760);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mobileRef.current) {
        setMobile(false);
        document.querySelector<HTMLButtonElement>(".mobile-toggle")?.focus();
      }
    };
    addEventListener("resize", resize);
    addEventListener("keydown", escape);
    return () => {
      removeEventListener("resize", resize);
      removeEventListener("keydown", escape);
    };
  }, []);
  const [{ reload, invalidate, observe }] = useState(() => createStateRefreshCadence(async () => {
    try {
      const revision = rescanEventRevision.current;
      const s = await api<AppState>("/api/state");
      setState(s);
      syncSavedAppearance(s.settings);
      // Do not let a slower state response overwrite more recent progress events.
      if (revision === rescanEventRevision.current) setRescanProgress((s.reindexProgress as RescanProgress | null) ?? null);
      if (s.csrfToken) setCsrf(s.csrfToken);
      const failed = stateError.current;
      stateError.current = "";
      if (failed) setError((current) => current === failed ? "" : current);
    } catch (e) {
      stateError.current = String((e as Error).message);
      setError(stateError.current);
    }
  }, document, () => ({ coalesceMs: tunableValue(settingsRef.current ?? {}, "browser.refreshBatchMs"), minIntervalMs: tunableValue(settingsRef.current ?? {}, "browser.refreshSpacingS") * 1000 })));
  useEffect(() => {
    const stopRefresh = observe();
    reload();
    const closeEvents = connectLiveEvents({
      open: (reconnected) => {
        setConnected(true);
        if (reconnected) {setCsrf(''); void reload();}
      },
      error: () => setConnected(false),
      message: (message) => {
        try {
          const data = JSON.parse(message.data);
          if (data.type === "connected") return;
          if (data.type === "reindex-progress") {
            rescanEventRevision.current++;
            setRescanProgress(data.progress);
            return;
          }
        } catch { /* Normal invalidations still refresh state. */ }
        invalidate();
      },
      invalidate,
    });
    const hash = () => {
      setRoute(location.hash.slice(1).split("/"));
      setMobile(false);
    };
    addEventListener("hashchange", hash);
    return () => {
      closeEvents();
      stopRefresh();
      removeEventListener("hashchange", hash);
    };
  }, [reload, invalidate, observe]);
  // Global shortcuts. Capture phase so a consumed key (for example the "o"
  // in "g o") never reaches page-level list shortcuts.
  useEffect(() => {
    let pendingG = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || helpRef.current || hasModifier(event) || isTypingTarget(event.target)) {
        pendingG = 0;
        return;
      }
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const key = event.key;
      if (pendingG && Date.now() - pendingG <= 1000) {
        pendingG = 0;
        const target = goKeys[key.toLowerCase()];
        if (target) {
          consume();
          setSearch("");
          location.hash = `#${target[0]}`;
        }
        return;
      }
      pendingG = 0;
      if (key === "/") {
        const input = document.querySelector<HTMLInputElement>(".global-search input");
        if (input && input.offsetParent !== null) {
          consume();
          input.focus();
          input.select();
        }
      } else if (key === "?") {
        consume();
        setHelp(true);
      } else if (key === "g" && !event.shiftKey) {
        pendingG = Date.now();
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);
  const mutate: Mutate = async (path, body, method) => {
    setBusy(true);
    try {
      const result = await api(path, body, method);
      await reload();
      return result;
    } catch (e) {
      const target = path.match(/^\/api\/(openings|applications)\/([^/?]+)/);
      const id = target ? decodeURIComponent(target[2]) : body?.openingId;
      const openingId = target?.[1] === "applications" ? state?.applications.find(a => a.id === id)?.openingId : id;
      const opening = state?.openings.find(o => o.id === openingId);
      const failure = e instanceof Error ? e : new Error(String(e));
      failure.message = openingErrorMessage(opening, failure);
      setError(failure.message);
      throw failure;
    } finally {
      setBusy(false);
    }
  };
  const go: Go = (page, id) => {
    setSearch("");
    location.hash = `#${page}${id ? "/" + encodeURIComponent(id) : ""}`;
  };
  const page = route[0] || "overview",
    selected = route[1] ? decodeURIComponent(route[1]) : "";
  const agent = (context: Partial<Context>, preset = "job-fit") => {
    setAgentContext({ documentIds: [], ...context });
    go("agents", `new:${preset}`);
  };
  const personal = (id: string, fields: any) =>
    mutate(entityUrl("/api/personal", id), {
      expectedVersion: state?.personal[id]?.version || 0,
      ...fields,
    });
  useEffect(() => {
    if (!selected || innerWidth > 1050) return;
    const timer = setTimeout(
      () =>
        document
          .querySelector(".detail-panel, .document-view, .agent-main")
          ?.scrollIntoView({ block: "start", behavior: "instant" }),
      80,
    );
    return () => clearTimeout(timer);
  }, [page, selected]);
  const pageEntry = pages.find((p) => p[0] === page);
  const showHeaderActions = pageEntry?.[3] === "actions";
  const navItem = ([id, title, Icon]: PageEntry) => (
    <AppLink
      key={id}
      className={`nav-item ${page === id ? "active" : ""}`}
      go={go} page={id}
      aria-current={page === id ? "page" : undefined}
    >
      <Icon size={19} strokeWidth={1.7} />
      <span>{title}</span>
      {state && <NavigationCount id={id} state={state}
        visibleOpeningCount={page === "openings" && !search ? visibleOpeningCount : null} />}
    </AppLink>
  );
  const name =
    pageEntry?.[1] ||
    (page === "settings" ? "Workspace settings" : "Overview");
  return (
    <div className="app-shell" data-display-timezone={FIELDWORK_TIMEZONE}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? "mobile-open" : ""}`}
        inert={narrow && !mobile}
        aria-hidden={narrow && !mobile}
      >
        <AppLink
          className="brand"
          go={go} page={"overview"}
          aria-label="Fieldwork overview"
        >
          <span className="brand-mark">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>
            fieldwork
            <span className="brand-caption">A PERSONAL JOB SEARCH</span>
          </span>
        </AppLink>
        <div className="workspace-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {pages.map(navItem)}
        </nav>
        <div className="sidebar-note">
          <span>Job search workspace</span>
        </div>
        <div className="sidebar-bottom">
          <AppLink
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            go={go} page={"settings"}
          >
            <Settings2 size={18} /> Settings & backup
          </AppLink>
          <div className="profile">
            <span className="avatar">U</span>
            <div>
              <strong>You</strong>
              <span>
                <i className={`status-dot ${connected ? "" : "offline"}`} />{" "}
                Private workspace
              </span>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <button
            className="icon-button mobile-toggle"
            aria-label="Toggle navigation"
            title="Toggle navigation"
            aria-expanded={mobile}
            aria-controls="workspace-sidebar"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={22} />
          </button>
          <div className="breadcrumb">
            My job search <ChevronRight size={13} /> <span>{name}</span>
          </div>
          <div className="global-search">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search your workspace…"
            />
          </div>
          <span className={`connection ${connected ? "" : "warning"}`}>
            <i className={`status-dot ${connected ? "" : "offline"}`} />
            {connected ? "Private · No telemetry" : "Reconnecting"}
          </span>
          <ThemeSwitch />
          <ThemeEditorButton />
          <ReloadAppButton onError={setError} go={go} settings={state?.settings} />
        </div>
        {typeof import.meta.env !== "undefined" && import.meta.env.DEV && <DevBadge />}
        <main id="main-content" tabIndex={-1}>
          <header className="page-header">
            <div>
              <h1>{search ? "Search the workspace" : name}</h1>
              {search && <p>Results for “{search}” across your research and materials.</p>}
            </div>
            {showHeaderActions && <div className="row-wrap page-actions">
            {state && <ValidateOpeningsButton state={state} mutate={mutate} />}
            </div>}
          </header>
          <div id="app-reload-banner" />
          {rescanning && <div className="banner rescan-progress" role="status" aria-live="polite">
            <LoaderCircle size={18} className="spin" />
            <div>
              <strong>{rescanProgress ? rescanProgressLabel(rescanProgress) : "Rescanning local files…"}</strong>
              <InfoTooltip label="About file rescanning">You can keep browsing while local files are checked.</InfoTooltip>
              <progress aria-label={rescanProgress ? rescanProgressLabel(rescanProgress) : "File rescan progress"}
                max={rescanProgress?.total || undefined}
                value={rescanProgress?.total ? rescanProgress.completed : undefined} />
            </div>
          </div>}
          {rescanResult && !rescanning && <div className={`banner ${rescanResult.incomplete ? "warning" : ""}`} role="status">
            {rescanResult.incomplete ? <AlertTriangle size={18} /> : <Check size={18} />}
            <div className="rescan-result">
              <span>{rescanMessage(rescanResult)}</span>
              {rescanResult.incomplete && <RescanProblems issues={state?.health ?? []} />}
            </div>
            <button className="icon-button" aria-label="Dismiss rescan result" title="Dismiss rescan result" onClick={() => setRescanResult(null)}><X size={16} /></button>
          </div>}
          {state && page !== "openings" && (state.openingValidation as any)?.status === "running" && <OpeningValidationProgress state={state} go={go} />}
          {error && (
            <div className="banner danger" role="alert">
              <AlertTriangle size={18} />
              <ErrorNotice error={error} preserveContext />
              <button
                onClick={() => setError("")}
                className="icon-button"
                aria-label="Dismiss error"
                title="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!connected && (
            <div className="banner warning">
              <AlertTriangle size={18} />
              <span>
                Live updates are disconnected. Your saved work remains on disk;
                reconnecting will not restart agent tasks.
              </span>
              <button className="text-button" onClick={reload}>
                Refresh data
              </button>
            </div>
          )}
          <div className="toast-stack">
            {notices.map(notice => <Toast key={notice.id} notice={notice} onClose={closeNotice} go={go} seconds={tunableValue(state?.settings ?? {}, "browser.toastSeconds")} />)}
          </div>
          {!state ? (
            <Empty
              loading={!error}
              icon={LoaderCircle}
              title={
                error
                  ? "The local server is unavailable"
                  : "Opening your workspace…"
              }
            >
              <button className="button secondary" onClick={reload}>
                Retry connection
              </button>
            </Empty>
          ) : (
            <WorkspaceProvider value={{ state, selected, go, personal, mutate, agent, notify }}>
              <AppPageWithReplies
                state={state}
                page={page}
                selected={selected}
                search={search}
                go={go}
                personal={personal}
                mutate={mutate}
                agent={agent}
                notify={notify}
                agentContext={agentContext}
                busy={busy}
                rescanning={rescanning}
                rescanProgress={rescanProgress}
                onVisibleOpeningCountChange={setVisibleOpeningCount}
                refresh={reload}
                onRescan={() => {
                  setRescanResult(null);
                  setRescanPending(true);
                  mutate("/api/reindex", {})
                    .then((result) => setRescanResult(result.summary))
                    .catch(() => {})
                    .finally(() => setRescanPending(false));
                }}
              />
            </WorkspaceProvider>
          )}
        </main>
        <ShortcutHelp open={help} onClose={() => setHelp(false)} />
        <footer className="workspace-footer">
          <span>Private workspace · No telemetry</span>
          <span>
            {state
              ? `Files indexed ${formatDate(state.importedAt, true)}`
              : "Connecting to local server"}
          </span>
        </footer>
      </div>
    </div>
  );
}
