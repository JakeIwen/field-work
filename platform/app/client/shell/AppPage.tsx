import type { AppState } from "../../shared/types";
import type { RescanProgress } from "../../shared/rescan-progress";
import CareersScans from "../pages/CareersScans";
import GmailReplies from "../gmail/GmailReplies";
import Questions from "../pages/Questions";
import ApprovalRequest from "../agents/ApprovalRequest";
import type { Context } from "../agents/task-context";
import type { Go, Mutate, Notify } from "../workspace/workspace-actions";
import { Agents } from "../pages/Agents";
import { Applications } from "../pages/Applications";
import { Companies } from "../pages/Companies";
import { Documents } from "../pages/Documents";
import { GlobalSearch } from "../pages/GlobalSearch";
import { Openings } from "../pages/Openings";
import { Overview } from "../pages/Overview";
import { Settings } from "../pages/Settings";

type Personal = (id: string, fields: unknown) => Promise<unknown>;
type Agent = (context: Partial<Context>, preset?: string) => void;

type AppPageProps = {
  state: AppState;
  page: string;
  selected: string;
  search: string;
  go: Go;
  personal: Personal;
  mutate: Mutate;
  agent: Agent;
  notify: Notify;
  agentContext: Context;
  busy: boolean;
  rescanning: boolean;
  rescanProgress: RescanProgress | null;
  onRescan: () => void;
  onVisibleOpeningCountChange: (count: number) => void;
  refresh: () => Promise<void>;
};

export function AppPage({
  state,
  page,
  selected,
  search,
  go,
  personal,
  mutate,
  agent,
  notify,
  agentContext,
  busy,
  rescanning,
  rescanProgress,
  onRescan,
  onVisibleOpeningCountChange,
  refresh,
}: AppPageProps) {
  if (page === "replies" && !search) return null;
  if (search) return <GlobalSearch state={state} query={search} go={go} />;
  if (page === "openings") {
    return <Openings state={state} selected={selected} go={go} personal={personal} mutate={mutate} notify={notify}
      onVisibleCountChange={onVisibleOpeningCountChange} refresh={refresh} />;
  }
  if (page === "companies") {
    return <Companies state={state} selected={selected} go={go} personal={personal} agent={agent} mutate={mutate} />;
  }
  if (page === "applications") {
    return <Applications state={state} selected={selected} go={go} mutate={mutate} agent={agent} notify={notify} />;
  }
  if (page === "documents") {
    return <Documents state={state} selected={selected} go={go} mutate={mutate} agent={agent} />;
  }
  if (page === "questions") {
    return (
      <Questions
        state={state}
        selected={selected}
        go={go}
        mutate={mutate}
        renderApproval={(task, event) => (
          <ApprovalRequest key={event.requestId} task={task} event={event} mutate={mutate} />
        )}
      />
    );
  }
  if (page === "scans") return <CareersScans state={state} go={go} mutate={mutate} />;
  if (page === "agents") {
    return <Agents state={state} selected={selected} go={go} mutate={mutate} context={agentContext} />;
  }
  if (page === "settings") {
    return (
      <Settings
        state={state}
        mutate={mutate}
        go={go}
        notify={notify}
        maintenance={{
          disabled: busy || rescanning,
          rescanning,
          progress: rescanProgress,
          onRescan,
        }}
      />
    );
  }
  return <Overview state={state} go={go} agent={agent} />;
}

export function AppPageWithReplies(props: AppPageProps) {
  const { state, page, search, go } = props;
  return (
    <>
      {(page !== "settings" || search) && (
        <GmailReplies state={state} page={search ? "search" : page} go={go} heading={!(page === "replies" && !search)} />
      )}
      <AppPage {...props} />
    </>
  );
}
