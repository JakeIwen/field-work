import { tunableValue } from "../../../shared/tunables";
import { useOptionalWorkspace } from "../../workspace/workspace";
import { useEffect, useRef, useState } from "react";
import { api } from "../../workspace/api";
import type { Mutate } from "../../workspace/workspace-actions";
import { openingErrorMessage } from "../../../shared/opening-error";
import { hostedApplication, hostedApplicationProviderLabels } from "../../../shared/application-host";
import { autofillPreparationView, type AutofillRecord, type AutofillQuestion, type AutofillHistoryRecord } from "../../../shared/greenhouse-autofill";
import { isTaskBusy, type Opening, type AppState } from "../../../shared/types";
import type { ApplicationPreparation } from "../../../shared/application-preparation";
import { useAutofillActivity } from "./useAutofillActivity";
import { sendAutofillToTab, tabAutofillTiming } from "./greenhouse-tab-autofill";

export type GreenhouseAutofillProps = {
  opening: Opening; mutate: Mutate; refreshKey?: string; tasks: AppState["tasks"];
  preparation?: ApplicationPreparation; preparing?: boolean;
};
export function useGreenhouseAutofill({ opening, mutate, refreshKey, tasks, preparation, preparing = false }: GreenhouseAutofillProps) {
  const settings = useOptionalWorkspace()?.state.settings ?? {};
  const [saved, setSaved] = useState<AutofillRecord[]>([]);
  const [history, setHistory] = useState<AutofillHistoryRecord[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [copyPhase, setCopyPhase] = useState<'idle' | 'copying' | 'copied' | 'submitted'>('idle');
  const [code, setCode] = useState('');
  const [tabWaiting, setTabWaiting] = useState(false);
  const requestEpoch = useRef(0);
  const historyRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setCopyPhase('idle');
    setCode('');
  }, [saved[0]?.id]);
  const application = hostedApplication(opening.url);
  const endpoint = `/api/openings/${encodeURIComponent(opening.id)}/autofill`;
  const autofillTaskActive = tasks.some(t =>
    t.autofillContext && t.context?.openingId === opening.id
    && (isTaskBusy(t.status) || t.autofillResult?.status === 'saving'));
  const activity = useAutofillActivity(endpoint, !!application, working || preparing || autofillTaskActive, refreshKey, tunableValue(settings, "browser.autofillPollMs"));
  useEffect(() => {
    requestEpoch.current++;
    historyRequest.current?.abort();
    historyRequest.current = undefined;
    setSaved([]);
    setHistory(null);
    setHistoryLoading(false);
    return () => historyRequest.current?.abort();
  }, [endpoint, opening.hash, opening.url, refreshKey]);
  useEffect(() => {
    if (!application) {setLoading(false); return;}
    const controller = new AbortController();
    setLoading(true);
    api(`${endpoint}?latest=1`, undefined, undefined, {
      responseType: 'response',
      signal: controller.signal,
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not load saved scripts.');
      if (!controller.signal.aborted) setSaved(data);
    }).catch(e => {if (!controller.signal.aborted) setError(e.message);})
      .finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [endpoint, opening.url, opening.hash, refreshKey]);
  const latest = saved[0];
  const answerTask = tasks.filter(t => t.autofillContext && t.context?.openingId === opening.id).at(-1);
  const drafting = answerTask && (isTaskBusy(answerTask.status) || answerTask.autofillResult?.status === 'saving');
  const preparationView = latest ? autofillPreparationView(latest, preparation, !!drafting) : undefined;
  const answerFailed = answerTask && (['failed', 'interrupted', 'unavailable', 'disconnected'].includes(answerTask.status) || answerTask.autofillResult?.status === 'failed')
    && (!latest || !answerTask.updatedAt || answerTask.updatedAt >= latest.createdAt || preparationView?.incomplete);
  const finishItems = preparationView?.finishItems ?? [];
  async function draftAnswers() {
    if (!latest) return;
    setWorking(true); setError('');
    try {
      if (preparationView?.retryPreparation) await mutate(`/api/openings/${encodeURIComponent(opening.id)}/prepare`, {});
      else {
        const record = await mutate(`${endpoint}/${encodeURIComponent(latest.id)}/answers`, {});
        if (record?.scriptHash) {
          setHistory(old => old ? [{ id: record.id, version: record.version, createdAt: record.createdAt }, ...old.filter(s => s.id !== record.id)] : null);
          setSaved(old => [record, ...old.filter(s => s.id !== record.id)]);
        }
      }
    }
    catch (e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setWorking(false);}
  }
  async function review(q: AutofillQuestion, answer: string) {
    const record = await mutate(`${endpoint}/answers/${encodeURIComponent(q.taskId!)}/${q.key}/review`, {answer, answerHash: q.answerHash, scriptId: saved[0]?.id});
    setHistory(old => old ? [{ id: record.id, version: record.version, createdAt: record.createdAt }, ...old.filter(s => s.id !== record.id)] : null);
    setSaved(old => [record, ...old.filter(s => s.id !== record.id)]);
  }
  async function savedScript(record: AutofillRecord) {
    const response = await api(`${endpoint}/${encodeURIComponent(record.id)}`, undefined, undefined, { responseType: 'response' });
    if (!response.ok) {const data = await response.json(); throw new Error(data.error || 'Could not load the script.');}
    return response.text();
  }
  async function copy() {
    if (!latest || copyPhase === 'copying' || copyPhase === 'copied') return;
    setError(''); setCopyPhase('copying');
    try {
      const script = await savedScript(latest);
      try {await navigator.clipboard.writeText(script);}
      catch {
        setCopyPhase('idle'); setCode(script);
        setError('Clipboard access failed. Select and copy the script below. Submission has not been recorded.');
        return;
      }
      setCode(''); setCopyPhase('copied');
      await recordSubmission(latest, 'Script copied, but submission could not be recorded. Click Autofill Script to retry.');
    } catch (e) {
      setCopyPhase('idle'); setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function recordSubmission(record: AutofillRecord, failure: string) {
    try {
      await api(`${endpoint}/${encodeURIComponent(record.id)}/copied`, {});
      setCopyPhase('submitted');
    } catch (e) {
      setCopyPhase('idle');
      setError(`${failure} ${openingErrorMessage(opening, e)}`);
    }
  }
  // Runs in the click that opened `tab`. OpeningActions withdraws the launcher while this waits, so runs never overlap.
  async function runInTab(tab: Window) {
    if (!latest) return;
    setError(''); setTabWaiting(true);
    try {
      const outcome = await sendAutofillToTab({ timeouts: tabAutofillTiming(settings), tab, formUrl: latest.url, script: savedScript(latest), label: `v${latest.version}` });
      if (outcome === 'accepted')
        await recordSubmission(latest, 'Autofill started in the Greenhouse tab, but submission could not be recorded. Click Autofill Script to record it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTabWaiting(false);
    }
  }
  async function loadHistory() {
    if (history || historyLoading) return;
    const epoch = requestEpoch.current;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    try {
      const records = await api<AutofillHistoryRecord[]>(`${endpoint}?history=1`, undefined, undefined, { signal: controller.signal });
      if (!controller.signal.aborted && requestEpoch.current === epoch) setHistory(records);
    }
    catch (e) { if (!controller.signal.aborted && requestEpoch.current === epoch) setError(e instanceof Error ? e.message : String(e)); }
    finally {
      if (historyRequest.current === controller) historyRequest.current = undefined;
      if (!controller.signal.aborted && requestEpoch.current === epoch) setHistoryLoading(false);
    }
  }
  const reloadSaved = async () => {
    const epoch = requestEpoch.current;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    try {
      const [latestRecords, historyRecords] = await Promise.all([
        api<AutofillRecord[]>(`${endpoint}?latest=1`, undefined, undefined, { signal: controller.signal }),
        history ? api<AutofillHistoryRecord[]>(`${endpoint}?history=1`, undefined, undefined, { signal: controller.signal }) : undefined,
      ]);
      if (controller.signal.aborted || requestEpoch.current !== epoch) return;
      setSaved(latestRecords);
      if (historyRecords) setHistory(historyRecords);
    } catch (e) {
      if (!controller.signal.aborted && requestEpoch.current === epoch) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted && requestEpoch.current === epoch) setHistoryLoading(false);
      if (historyRequest.current === controller) historyRequest.current = undefined;
    }
  };
  return { opening, saved, latest, history, historyLoading, loading, working, error, setError, activity, copyPhase, code, setCode, endpoint, tabWaiting,
    eligible: !!application, provider: application?.provider, providerLabel: application ? hostedApplicationProviderLabels[application.provider] : undefined,
    drafting: !!drafting, preparing, answerFailed: !!answerFailed, answerTask, preparationView, finishItems,
    canCopy: !!latest && !preparing && !drafting && !preparationView?.incomplete,
    draftAnswers, review, copy, runInTab, loadHistory, reloadSaved,
  };
}
export type GreenhouseAutofillController = ReturnType<typeof useGreenhouseAutofill>;
