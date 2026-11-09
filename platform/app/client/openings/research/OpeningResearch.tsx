import type { Opening } from "../../../shared/types";
import { hostedApplicationProviderLabels } from "../../../shared/application-host";
import { openingPullDateLabels } from "../../../shared/opening-pull";
import { openingAssessmentDetails, openingAssessmentValuesFor } from "../../../shared/opening-assessments";
import { openingAddedDate, openingPostedDate } from "../opening-sort";
import { formatDate } from "../../ui/dates";
import { Field } from "../../ui/Field";
import { Source } from "../../ui/Source";
import { AlertTriangle } from "lucide-react";
import InfoTooltip from "../../ui/InfoTooltip";
import ResearchText, { ResearchBullets } from "./ResearchText";

// Import records `{differences: [{field, current, snapshot}]}` per disagreement (import-repository.ts).
function discrepancyFields(discrepancy: unknown[]) {
  return discrepancy.flatMap((entry) => {
    const differences = (entry as { differences?: unknown } | null)?.differences;
    return Array.isArray(differences)
      ? differences.map((d) => String((d as { field?: unknown } | null)?.field ?? "")).filter(Boolean)
      : [];
  });
}

export default function OpeningResearch({ opening: o }: { opening: Opening }) {
  const notes = ["Scan “NEW” means first observed here, not newly posted.", o.verificationNotes && String(o.verificationNotes)].filter(Boolean).join("\n\n");
  return <details className="opening-research-details">
    <summary>Role details & research <InfoTooltip label="About role research">{notes}</InfoTooltip></summary>
    {Boolean(o.lastCheckedAt) && <p className="small muted">Posting checked {formatDate(String(o.lastCheckedAt), true)}.</p>}
    <AssessmentFields opening={o} />
    <Field label="Why it fits"><ResearchText text={o.why} /></Field>
    <Field label={<>Published compensation <InfoTooltip label="About published compensation">Source wording preserves geographic bands and separates base from other compensation.</InfoTooltip></>}>
      <ResearchText text={o.compensation} />
    </Field>
    <Field label="Work location & mobility"><ResearchText text={o.location} /></Field>
    <div className="concerns"><Field label="Tradeoffs to investigate"><ResearchText text={o.concerns} /></Field></div>
    <Field label="Work-life balance evidence"><ResearchText text={o.wlb_evidence} /></Field>
    <Field label="Role requirements"><ResearchText text={o.requirements} /></Field>
    <div className="date-grid">
      <Field label="Posted">{formatDate(openingPostedDate(o))}</Field>
      <ProviderDate opening={o} />
      <Field label="Added">{formatDate(openingAddedDate(o).value)}{openingAddedDate(o).approximate ? " (first seen)" : ""}</Field>
      <Field label="First seen">{formatDate(o.first_seen)}</Field>
      <Field label="Last confirmed open">{formatDate(o.last_confirmed_open)}</Field>
      <Field label="Deadline">{formatDate(o.deadline)}</Field>
    </div>
    {!!o.discrepancy?.length && <div className="banner warning"><AlertTriangle size={18} /><span>The current openings Markdown and the dated scan snapshot disagree on: {discrepancyFields(o.discrepancy).join(", ") || "unknown fields"}.</span></div>}
    {o.sourcePath === "App-owned opening" ? <Field label="Research sources">
      {(Array.isArray(o.sources) ? o.sources as string[] : []).map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></p>)}
    </Field> : <Source path={o.sourcePath} date={o.sourceDate} />}
  </details>;
}

function ProviderDate({ opening }: { opening: Opening }) {
  const pullSource = opening.pullSource;
  if (!pullSource || pullSource.provider === "greenhouse") return null;
  const label = `${openingPullDateLabels[pullSource.provider]} on ${hostedApplicationProviderLabels[pullSource.provider]}`;
  return <Field label={label}>
    <a href={pullSource.date.source} target="_blank" rel="noreferrer">
      {pullSource.date.value ? formatDate(pullSource.date.value) : "Unknown"}
    </a>
  </Field>;
}

function AssessmentFields({ opening }: { opening: Opening }) {
  const ratings = openingAssessmentValuesFor(opening), assessments = openingAssessmentDetails(opening);
  return <>
    <div className="fit-grid">{[["Technical", ratings.technicalFit], ["Remote", ratings.remoteFit], ["WLB outlook", ratings.wlbOutlook]].map(([label, value]) =>
      <div key={label}><span>{label}</span><strong className={value === "High" ? "green-text" : ""}>{value || "Unknown"}</strong></div>)}
    </div>
    {([ ["Technical fit assessment", "technicalFit"], ["Remote fit assessment", "remoteFit"], ["WLB assessment", "wlbOutlook"] ] as const).map(([label, key]) =>
      assessments[key] && assessments[key] !== ratings[key] ? <Field key={key} label={label}><ResearchBullets text={assessments[key]} /></Field> : null)}
  </>;
}
