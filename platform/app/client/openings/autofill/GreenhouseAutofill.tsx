import { formatDate } from "../../ui/dates";
import ErrorNotice from "../../ui/ErrorNotice";
import DeleteRecord from "../../ui/DeleteRecord";
import InfoTooltip from "../../ui/InfoTooltip";
import { openingErrorMessage } from "../../../shared/opening-error";
import React, {useState} from "react";
import type { Opening } from "../../../shared/types";
import type { AutofillQuestion } from "../../../shared/greenhouse-autofill";
import type { GreenhouseAutofillController } from "./useGreenhouseAutofill";

export default function GreenhouseAutofill({ controller: c }: { controller: GreenhouseAutofillController }) {
  if (!c.eligible) return null;
  const { latest, opening, finishItems } = c;
  const providerLabel = c.providerLabel ?? "Application";
  const required = finishItems.filter(q => q.required);
  return <section className="greenhouse-autofill" aria-label={`${providerLabel} autofill`}>
    <div className="section-divider" />
    <div className="autofill-heading"><h3>Written answers ({providerLabel})</h3>
      <InfoTooltip label="About saved application answers">Your saved answers carry forward to new scripts for these questions. Only unsaved answers are redrafted.</InfoTooltip>
    </div>
    {c.loading && <p role="status" className="small muted">Loading saved answers…</p>}
    {latest && <>
      <p className="small autofill-disclosure">Running this script sends its included answers and files to the employer before you click the final Submit button. Copying the script also records the submission in Fieldwork; it does not confirm employer receipt.</p>
      <div className="autofill-version-row"><DeleteRecord kind="application_autofill" id={latest.id} label={`autofill version ${latest.version}`} onDeleted={() => {c.setCode(''); void c.reloadSaved();}} />
        <p className="small">Saved version {latest.version} · {formatDate(latest.createdAt, true)} · {latest.answers.length} answers included</p>
      </div>
      {(latest.dynamicQuestions ?? []).map(q => <WrittenAnswer key={`${q.key}:${q.answerHash || 'pending'}`} question={q} pendingLabel={c.preparationView?.pendingLabel || 'Not prepared'} opening={opening} onReview={answer => c.review(q, answer)} />)}
      <details className="opening-file-history"><summary>Review included answers ({latest.answers.length})</summary>
        <dl>{latest.answers.map((answer, i) => <React.Fragment key={i}><dt className="small">{answer.label}</dt><dd className="small">{answer.value}</dd></React.Fragment>)}</dl>
      </details>
      {required.length > 0 && <p className="small">Still required: {required.length} {required.length === 1 ? 'item' : 'items'}; review the list below.</p>}
      {finishItems.length > 0 && <details className="opening-file-history"><summary>Finish on the application ({finishItems.length})</summary>
        <ul>{finishItems.map((q, i) => <li key={i} className="small"><strong>{q.label}{q.required ? ' (required)' : ''}</strong> — {q.reason}</li>)}</ul>
      </details>}
      {latest.version > 1 && <details className="opening-file-history" onToggle={event => {
        if (event.currentTarget.open) void c.loadHistory();
      }}><summary>Earlier scripts</summary>
        {c.historyLoading && <p role="status" className="small muted">Loading earlier scripts…</p>}
        {c.history?.filter(script => script.id !== latest.id).map(script => <div key={script.id} className="small"><a href={`${c.endpoint}/${encodeURIComponent(script.id)}?download=1`} download>Version {script.version} · {formatDate(script.createdAt, true)}</a><DeleteRecord kind="application_autofill" id={script.id} label={`autofill version ${script.version}`} onDeleted={() => void c.reloadSaved()} /></div>)}
        {c.history && c.history.every(script => script.id === latest.id) && <p className="small muted">No earlier scripts remain.</p>}
      </details>}
    </>}
    {c.code && <textarea aria-label="Autofill script to copy" readOnly rows={8} value={c.code} onFocus={e => e.currentTarget.select()} />}
  </section>;
}

function WrittenAnswer({question: q, pendingLabel, opening, onReview}: {question: AutofillQuestion; pendingLabel: string; opening: Opening; onReview: (answer: string) => Promise<void>}) {
  // A single-line input cannot show line breaks, so start from the one-line text the form would hold.
  const [answer, setAnswer] = useState(q.kind === 'text' ? (q.answer ?? '').replace(/\s*[\r\n]+\s*/g, ' ') : q.answer ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <details className="opening-answer" open={q.manualReviewRequired || q.needsInput}>
    <summary>{q.label}{q.manualReviewRequired ? ' · Manual review required' : q.notApplicable ? ' · Not applicable' : q.reviewedAt ? ' · Saved answer included' : q.answer ? ' · Answer included' : ` · ${pendingLabel}`}{!!q.sourcePaths?.length && <> <InfoTooltip label={`Evidence for ${q.label}`}>{`Evidence: ${q.sourcePaths.join(', ')}`}</InfoTooltip></>}</summary>
    {q.manualReviewRequired && <p role="status" className="error-text">Manual review required: {q.reviewReason} This answer is not included in the script yet.</p>}
    {q.taskId && <>
      <label htmlFor={`written-answer-${q.key}`}>Review or edit this answer</label>
      {q.kind === 'select' ? <select id={`written-answer-${q.key}`} value={answer} onChange={e=>setAnswer(e.target.value)}>
        <option value="">Choose an offered answer</option>
        {q.options?.map(option=><option key={option} value={option}>{option}</option>)}
      </select> : q.kind === 'text'
        ? <input id={`written-answer-${q.key}`} type="text" maxLength={q.maxLength} value={answer} onChange={e => setAnswer(e.target.value)} title="Single-line field on the application form" />
        : <textarea id={`written-answer-${q.key}`} rows={7} maxLength={q.maxLength} value={answer} onChange={e => setAnswer(e.target.value)} />}
      {q.notApplicable && <p className="small muted">Not applicable based on saved facts; left blank.</p>}
      {!!q.caveats?.length && <ul>{q.caveats.map((c, i) => <li key={i} className="small">{c}</li>)}</ul>}
      <button className="button secondary" disabled={saving || !answer.trim()} onClick={async () => {
        setSaving(true); setError('');
        try {await onReview(answer);} catch (e) {setError(e instanceof Error ? e.message : String(e));} finally {setSaving(false);}
      }}>{saving ? 'Saving…' : 'Use reviewed answer in script'}</button>
    </>}
    {error && <ErrorNotice error={openingErrorMessage(opening, error)} />}
  </details>;
}
