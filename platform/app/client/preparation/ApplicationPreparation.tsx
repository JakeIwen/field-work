import { answersOnlyGestureTitle, answersOnlyStatus, preparationRequestNotice, preventShiftTextSelection } from "./preparation-request";
import type { AnswersOnlyAutofillCount } from "../../shared/application-preparation";
import "./answers-only.css";
import { applicationMaterialWarnings, sentMaterial } from "./application-material-warnings";
import DeleteRecord from "../ui/DeleteRecord";
import ErrorNotice from "../ui/ErrorNotice";
import InfoTooltip from "../ui/InfoTooltip";
import AppLink from "../ui/AppLink";
import { PreparationActivityDetails, PreparationLiveLine } from "./PreparationActivity";
import { usePreparationActivity } from "./usePreparationActivity";
import type { TaskSummary } from "../../shared/types";
import {hostedApplication, hostedApplicationProviderLabels} from '../../shared/application-host';
import React, {useState} from 'react';
import {AlertTriangle, Check, LoaderCircle, Sparkles} from 'lucide-react';
import {preparationBusy, preparationDocumentKinds, preparationDocumentsSaved, type ApplicationPreparation} from '../../shared/application-preparation';
type Props = {openingId: string; openingUrl: string; run?: ApplicationPreparation; submitted?: boolean; active?: boolean; compact?: boolean; finishCount?: number; answerCount?: AnswersOnlyAutofillCount; announce?: (message: string) => void; listingLabel?: string; mutate: (path: string, body: any, method?: string) => Promise<any>};

export function GenerateDocumentsButton({openingId, openingUrl, run, submitted = false, active = false, compact = false, finishCount, answerCount, announce, listingLabel, mutate}: Props) {
  const [starting, setStarting] = useState(false), [error, setError] = useState('');
  const busy = starting || preparationBusy(run) || active;
  const application = hostedApplication(openingUrl);
  const providerLabel = application ? hostedApplicationProviderLabels[application.provider] : '';
  const service = providerLabel ? ` (${providerLabel})` : '';
  const autofillDescription = providerLabel
    ? ` For this ${providerLabel} posting, also prepare written answers and an autofill script with the files attached.`
    : ' For supported hosted applications, also prepare written answers and an autofill script with the files attached.';
  const failure = error || (run?.status === 'failed' ? run.error : '');
  const attention = !busy ? applicationMaterialWarnings(sentMaterial(run, submitted), undefined, error).join('\n\n') : '';
  const compactAttention = compact ? attention : '';
  const info = !busy && !attention && answerCount ? answersOnlyStatus(answerCount.count) : '';
  const count = answerCount?.count ?? finishCount;
  const finishLabel = count === undefined ? '' : `(${count})`;
  const title = compactAttention ? `${compactAttention}\nClick to refresh or continue preparation.` : info ? `${info}. Click to finish the documents.` : `${run?.status === 'queued' ? 'Queued. ' : busy ? 'Generation in progress. ' : ''}Generate or reuse your tailored resume and cover letter PDFs.${autofillDescription}${compact ? ' The number counts items still to finish on the application in the latest autofill script.' : ''}`;
  return <>
    <button className={`button primary${compact ? ' opening-generate-docs' : ''}${compactAttention ? ' materials-need-attention' : info ? ' materials-answers-only' : ''}`} disabled={busy}
      aria-label={compact ? `${busy ? 'Generating' : 'Generate'} Docs${service} for ${listingLabel || openingId}${count === undefined ? '' : ` · ${count} to finish on the application`}${compactAttention ? ' · Materials need attention' : info ? ' · Answers only' : ''}` : undefined}
      aria-description={compactAttention || info || undefined}
      title={`${title} ${answersOnlyGestureTitle}`}
      onMouseDown={preventShiftTextSelection}
      onClick={async event => {
        event.stopPropagation();
        const scope = event.shiftKey ? 'answers' : 'full';
        const notice = preparationRequestNotice(run, scope);
        if (notice) { announce?.(notice); return; }
        setStarting(true); setError('');
        try { await mutate(`/api/openings/${encodeURIComponent(openingId)}/prepare`, scope === 'answers' ? { scope } : {}); }
        catch(e) { const message = e instanceof Error ? e.message : String(e); setError(message); announce?.(message); }
        finally { setStarting(false); }
      }}>
      {busy ? <LoaderCircle size={compact ? 12 : 16} className="spin" /> : compactAttention ? <AlertTriangle size={12} aria-hidden="true" /> : <Sparkles size={compact ? 12 : 16} />}
      {compact ? finishLabel : busy ? `Generating Docs${service}…` : `Generate Docs${service}`}
    </button>
    {failure && !compact && <ErrorNotice error={failure} fallback="Document generation failed. Open error details or retry when ready." />}
  </>;
}

/** The documents row; a form without a cover-letter upload slot expects the resume alone. */
function DocumentsLine({run, ready}: {run: ApplicationPreparation; ready: boolean}) {
  const status = ready ? 'saved and validated' : run.phase === 'documents' ? 'in progress' : 'pending';
  return preparationDocumentKinds(run).length === 1
    ? <li>Resume: {status}. This form has no cover-letter upload slot.</li>
    : <li>Resume + cover letter: {status}</li>;
}

export function PreparationProgress({run, go, showScriptLink = false}: {run?: ApplicationPreparation; go: (page: string, id?: string) => void; showScriptLink?: boolean}) {
  if (!run) return null;
  const documentsReady = preparationDocumentsSaved(run);
  return <div className="preparation-progress" aria-label="Application preparation progress">
    <DeleteRecord kind="application_preparation" id={run.id} label="application preparation" /><div className="preparation-progress-heading heading-help"><strong role={run.status === 'failed' ? 'alert' : 'status'}>{run.status === 'failed' ? 'Application preparation failed.' : run.message}</strong>{preparationBusy(run) && <InfoTooltip label="About application preparation progress">You can leave this page. Preparation continues in Fieldwork.</InfoTooltip>}{run.status === 'ready' && <InfoTooltip label="About the saved application package">Review the saved script and documents before using them. Preparation does not submit the employer’s form.</InfoTooltip>}</div>
    {run.error && <ErrorNotice error={run.error} />}
    {run.stale && <p className="error-text">Sources or documents changed. Use Generate Docs to refresh this package.</p>}
    <ul className="small">
      <DocumentsLine run={run} ready={documentsReady} />
      {run.supportedForm && <><li>Written answers: {['packaging','ready'].includes(run.phase) ? 'drafted or flagged for review' : run.phase === 'answers' ? 'in progress' : 'pending'}</li>
      <li>Script with attachments: {run.status === 'ready' ? 'saved' : 'pending'}</li></>}
    </ul>
    {run.status === 'ready' && run.supportedForm && showScriptLink && <AppLink className="button secondary" go={go} page={'openings'} id={run.openingId}>Review the saved autofill script</AppLink>}
    <div className="opening-downloads">{run.taskIds.map((id, i) => <AppLink key={id} className="text-button small" go={go} page={'questions'} id={id}>{id === run.answerTaskId ? 'Answer task details' : `Document task${run.taskIds.filter(id=>id!==run.answerTaskId).length > 1 ? ' ' + (i + 1) : ''} details`}</AppLink>)}</div>
  </div>;
}

/** One-line preparation status for the Application view. The full block lives on the Opening. */
export function PreparationStatusLine({run, go, openingId, tasks = [], runs = []}: {run?: ApplicationPreparation; go: (page: string, id?: string) => void; openingId: string; tasks?: readonly TaskSummary[]; runs?: readonly ApplicationPreparation[]}) {
  const activity = usePreparationActivity(openingId, run?.scope === 'answers' ? undefined : run);
  // Answers-only exploration belongs on the Opening, not the application's document status.
  if (run?.scope === 'answers') return null;
  if (!run) return <div className="preparation-line" aria-label="Application preparation status">
    <span className="preparation-line-status"><span>No documents yet</span></span>
    <AppLink className="text-button" go={go} page={'openings'} id={openingId}>Generate on the Opening</AppLink>
  </div>;
  const busy = preparationBusy(run), failed = run.status === 'failed', ready = run.status === 'ready';
  const documentsReady = preparationDocumentsSaved(run);
  const label = busy ? run.message : failed ? 'Generation failed' : ready ? (run.stale ? 'Docs ready · sources changed since' : 'Docs ready') : run.message;
  return <div className={`preparation-line${failed ? ' is-failed' : run.stale ? ' is-stale' : ''}`} aria-label="Application preparation status">
    <span className="preparation-line-status" role={busy ? undefined : failed ? 'alert' : 'status'}>
      {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : failed || run.stale ? <AlertTriangle size={14} aria-hidden="true" /> : ready ? <Check size={14} aria-hidden="true" /> : null}
      {busy ? <PreparationLiveLine run={run} tasks={tasks} runs={runs} activity={activity} message={label} /> : <span>{label}</span>}
    </span>
    {ready && run.supportedForm && <AppLink className="text-button" go={go} page={'openings'} id={run.openingId}>Review autofill script</AppLink>}
    {(failed || run.stale) && !busy && <AppLink className="text-button" go={go} page={'openings'} id={run.openingId}>{failed ? 'Retry on the Opening' : 'Regenerate on the Opening'}</AppLink>}
    <details className="preparation-line-details">
      <summary>Details <InfoTooltip label="About application preparation details">Preparation does not submit the employer’s form.</InfoTooltip></summary><DeleteRecord kind="application_preparation" id={run.id} label="application preparation" />
      {run.error && <ErrorNotice error={run.error} />}
      {run.stale && <p className="small">Use Generate Docs on the Opening to refresh this package.</p>}
      <PreparationActivityDetails run={run} tasks={tasks} activity={activity} />
      <ul className="small">
        <DocumentsLine run={run} ready={documentsReady} />
        {run.supportedForm && <><li>Written answers: {['packaging','ready'].includes(run.phase) ? 'drafted or flagged for review' : run.phase === 'answers' ? 'in progress' : 'pending'}</li>
        <li>Script with attachments: {run.status === 'ready' ? 'saved' : 'pending'}</li></>}
      </ul>
      <div className="opening-downloads">{run.taskIds.map((id, i) => <AppLink key={id} className="text-button small" go={go} page={'questions'} id={id}>{id === run.answerTaskId ? 'Answer task details' : `Document task${run.taskIds.filter(id=>id!==run.answerTaskId).length > 1 ? ' ' + (i + 1) : ''} details`}</AppLink>)}</div>
    </details>
  </div>;
}
