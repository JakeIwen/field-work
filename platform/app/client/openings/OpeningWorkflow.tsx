import { answersOnlyStatus } from "../preparation/preparation-request";
import "../preparation/answers-only.css";
import { applicationMaterialWarnings, sentMaterial } from "../preparation/application-material-warnings";
import { errorSummary } from "../ui/ErrorNotice";
import AppLink from "../ui/AppLink";
import InfoTooltip from "../ui/InfoTooltip";
import { PreparationActivityDetails, PreparationLiveLine } from "../preparation/PreparationActivity";
import { usePreparationActivity } from "../preparation/usePreparationActivity";
import React, { useEffect, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Copy, Download, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { isTaskBusy, type AppState, type Opening, type Document } from "../../shared/types";
import GreenhouseAutofill from "./autofill/GreenhouseAutofill";
import { useGreenhouseAutofill, type GreenhouseAutofillController } from "./autofill/useGreenhouseAutofill";
import type { AutofillTabLauncher } from "./autofill/greenhouse-tab-autofill";
import { preparationBusy, preparationDocumentKinds, type ApplicationDocumentKind } from "../../shared/application-preparation";
import { openingDocumentTaskBusy } from "../../shared/opening-documents";
import { appliedOpeningIds } from "../../shared/opening-applications";
import { type Go, type Mutate } from "../workspace/workspace-actions";
export const taskBusy = (t: any) => t && (isTaskBusy(t.status) || t.documentResult?.status === "rendering");
export const taskFailed = (t: any) => t && (["failed", "interrupted", "unavailable", "disconnected"].includes(t.status) || t.importStatus === "failed" || t.documentResult?.status === "failed");

// A submitted application's files no longer need their writing-rule warnings.
export function openingFiles(state: AppState, openingId: string): Document[] {
  const submitted = appliedOpeningIds(state.applications).has(openingId);
  return state.documents.filter(d => d.openingId === openingId).map(d => submitted ? { ...d, writingRuleWarning: undefined } : d);
}

function latestMaterial(files: Document[], kind: ApplicationDocumentKind) {
  return files.filter(d => d.kind === kind && d.format === 'pdf' && d.privacy === 'private' && d.validation === 'passed' && d.status !== 'rejected')
    .sort((a, b) => (b.createdAt || b.modifiedAt || '').localeCompare(a.createdAt || a.modifiedAt || ''))[0];
}

function warningMessages(state: AppState, opening: Opening, c: GreenhouseAutofillController, error: string, busy: boolean, materials: (Document | undefined)[], submitted: boolean) {
  const preparation = state.preparations?.find(r => r.openingId === opening.id);
  const task = state.tasks.filter(t => t.context?.openingId === opening.id && ['posting-application', 'posting-resume', 'posting-cover-letter'].includes(t.preset)).at(-1);
  // What the last click got back leads; standing warnings about the materials follow.
  const errors = [error, c.error, ...applicationMaterialWarnings(sentMaterial(preparation, submitted), sentMaterial(c.latest, submitted)), ...materials.map(document => document?.writingRuleWarning),
    task && taskFailed(task) ? task.documentResult?.error || task.error || 'Document generation stopped.' : '',
    c.answerFailed ? c.answerTask?.autofillResult?.error || c.answerTask?.error || 'Answer preparation stopped.' : '', c.latest?.answerError,
  ].filter((value): value is string => !!value);
  if (!busy && c.preparationView?.incomplete && !c.preparationView.answersOnly && !errors.length)
    errors.push('Preparation is incomplete. Generate Docs to finish the answers and attachments.');
  // Finish items and out-of-date flags are moot once the application is submitted (owner, 2026-10-20).
  if (c.finishItems.length && !submitted && !c.preparationView?.answersOnly) errors.push(`${c.finishItems.length} ${c.finishItems.length === 1 ? 'item' : 'items'} still ${c.finishItems.length === 1 ? 'needs' : 'need'} attention under Finish on the application.`);
  const prefix = `${opening.company} · ${opening.title}: `;
  return [...new Set(errors.map(e => errorSummary(e.startsWith(prefix) ? e.slice(prefix.length) : e, 'Generation did not finish. Open Revise for details.')))];
}

function MaterialControl({ document, label, kind, busy, refresh, canRefresh = true }: { document?: Document; label: string; kind: ApplicationDocumentKind; busy: boolean; refresh: (kind: ApplicationDocumentKind) => void; canRefresh?: boolean }) {
  if (!document) return null;
  return <div className="opening-material-control">
    <a className="button secondary" href={`/api/documents/${encodeURIComponent(document.id)}/download`} download title={document.writingRuleWarning}>{label} <Download size={15} aria-hidden="true" /></a>
    {canRefresh && <button type="button" className="icon-button" aria-label={`Generate a new ${kind === 'resume' ? 'resume' : 'cover letter'} version`} title="Generate a new version" disabled={busy} onClick={() => refresh(kind)}><RefreshCw size={15} /></button>}
  </div>;
}

export function OpeningActions({ opening, state, mutate, go, controlsTarget, autofillLauncher }: { opening: Opening; state: AppState; mutate: Mutate; go: Go; controlsTarget?: HTMLElement | null; autofillLauncher?: MutableRefObject<AutofillTabLauncher | undefined> }) {
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const tasks = state.tasks.filter(t => t.context?.openingId === opening.id);
  const task = tasks.filter(t => ['posting-application', 'posting-resume', 'posting-cover-letter'].includes(t.preset)).at(-1);
  const preparation = state.preparations?.find(r => r.openingId === opening.id);
  const submitted = appliedOpeningIds(state.applications).has(opening.id);
  const files = openingFiles(state, opening.id);
  const resume = latestMaterial(files, 'resume'), letter = latestMaterial(files, 'cover-letter');
  // A form without a cover-letter upload slot needs only the resume; the run records what its form expects.
  const letterExpected = !preparation || preparationDocumentKinds(preparation).includes('cover-letter');
  const c = useGreenhouseAutofill({ opening, mutate, tasks, preparation, preparing: preparationBusy(preparation), refreshKey: state.openingAutofillScriptIds?.[opening.id] });
  const activity = usePreparationActivity(opening.id, preparation);
  const copyPending = c.copyPhase === 'copying' || c.copyPhase === 'copied';
  const copyLabel = c.copyPhase === 'copying' ? 'Copying…' : c.copyPhase === 'copied' ? 'Copied' : c.copyPhase === 'submitted' ? 'Submitted' : 'Autofill Script';
  const busy = (c.eligible && c.loading) || working || c.working || c.drafting || copyPending || c.tabWaiting || preparationBusy(preparation) || openingDocumentTaskBusy(opening.id, tasks) || !!c.activity?.running;
  const warnings = warningMessages(state, opening, c, error, busy, [resume, letterExpected ? letter : undefined], submitted);
  const [warningSummary, ...warningDetails] = warnings;
  const progressMessage = preparationBusy(preparation) ? undefined : c.copyPhase === 'copying' ? 'Copying the script…' : c.tabWaiting ? 'Waiting for the Greenhouse tab to load the autofill userscript…' : c.activity?.running ? c.activity.message : '';
  // The posting link reads this when clicked: it runs the script that Copy would copy, and only then.
  const launchInTab = c.eligible && c.canCopy && !busy ? c.runInTab : undefined;
  useEffect(() => {
    if (!autofillLauncher) return;
    autofillLauncher.current = launchInTab;
    return () => { autofillLauncher.current = undefined; };
  });
  async function prepare(documentKind?: ApplicationDocumentKind) {
    setWorking(true); setError('');
    try { await mutate(`/api/openings/${encodeURIComponent(opening.id)}/prepare`, documentKind ? { documentKind } : {}); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  }
  const controls = <section className={`opening-material-controls${warnings.length ? " materials-need-attention" : ""}`} aria-label="Application materials">
      {warningSummary && <div className="material-warning-summary">
        {warningDetails.length ? <InfoTooltip label="Application materials need attention" className="material-warning" icon={<AlertTriangle size={22} aria-hidden="true" />}>{warningDetails.join('\n\n')}</InfoTooltip>
          : <AlertTriangle className="material-warning" size={22} aria-hidden="true" />}
        <span>{warningSummary}</span>
      </div>}
      {!busy && !warnings.length && c.preparationView?.answersOnly && <p className="material-answers-status" role="status">{answersOnlyStatus(c.preparationView.answersOnlyFinishItems.length)}</p>}
      {c.eligible && c.canCopy ? <div className="opening-material-control">
        <button className="button primary" disabled={busy} title={`Copy the ${c.providerLabel ?? 'application'} autofill script and record submission in Fieldwork. Running it sends included answers and files to the employer before you click final Submit; review and submit the form yourself.`} onClick={c.copy}>{copyLabel} <Copy size={16} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="Refresh autofill script" title="Generate a new version" disabled={busy} onClick={c.draftAnswers}><RefreshCw size={15} /></button>
      </div> : (c.eligible || !resume || (letterExpected && !letter)) && <button className="button primary" disabled={busy} onClick={() => prepare()}>
        {busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />} {c.loading && c.eligible ? 'Loading…' : busy ? 'Preparing…' : 'Generate Docs'}
      </button>}
      <MaterialControl document={resume} label="Resume PDF" kind="resume" busy={busy} refresh={prepare} />
      <MaterialControl document={letter} label="Cover letter PDF" kind="cover-letter" busy={busy} refresh={prepare} canRefresh={letterExpected} />
      {task && <AppLink className="text-button small" go={go} page="questions" id={task.id}><Sparkles size={16} aria-hidden="true" /> Revise</AppLink>}
    </section>;
  return <section className="opening-workflow">
    {controlsTarget ? createPortal(controls, controlsTarget) : controls}
    {preparation && preparationBusy(preparation) && <>
      <p className="small muted"><PreparationLiveLine run={preparation} tasks={state.tasks} runs={state.preparations ?? []} activity={activity} message={preparation.message} /></p>
      <PreparationActivityDetails collapsible run={preparation} tasks={state.tasks} activity={activity} />
    </>}
    {busy && progressMessage && <p className="small muted" role="status">{progressMessage}</p>}
    <GreenhouseAutofill controller={c} />
  </section>;
}
