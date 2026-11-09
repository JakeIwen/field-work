import * as openingSkillFields from "../opening-skills-fields.js";
import { sha256 } from "../storage.js";
import { fieldsIn, isoDate, safeUrl, salaryBands } from "./parse-companies.js";
import {
  isOpeningAssessmentValue,
  normalizeOpeningAssessment,
  validOpeningAssessmentDetails,
  validOpeningDate,
} from "../../shared/opening-assessments.js";
import { validOpeningListSummary } from "../../shared/opening-list.js";
import type { Opening } from "../../shared/types.js";

export const OPENINGS_PATH = "company_careers/current_openings.md";

export const OPENING_FIELDS: Record<string, keyof Opening> = {
  "Location / remote status": "location",
  Compensation: "compensation",
  "Technical fit": "technical_fit",
  "Remote fit": "remote_fit",
  "WLB outlook": "wlb_outlook",
  Status: "status",
  "Why it fits": "why",
  "Main concerns": "concerns",
  "Key requirements": "requirements",
  "Useful WLB evidence": "wlb_evidence",
};

function recruiterQuestions(
  opening: Opening,
): { question: string; evidence: string; sourcePath: string }[] {
  const context = `${opening.location} ${opening.concerns} ${opening.wlb_evidence}`;
  const questions = [
    {
      question:
        "What hours did this team actually work in a typical week and during its last busy period?",
      evidence:
        opening.wlb_evidence || "Actual weekly hours are not documented.",
    },
    {
      question:
        "How often is the on-call rotation, how many after-hours pages occurred recently, and what recovery time is provided?",
      evidence:
        opening.concerns || "Team-specific paging frequency is not documented.",
    },
    {
      question:
        "Which US states may I work from, and what notice or approval is required when my physical work location changes?",
      evidence: opening.location || "Supported work locations are unknown.",
    },
  ];
  if (/travel|trip|gather|retreat|unspecified|unknown/i.test(context))
    questions.push({
      question:
        "What travel is required each year, for how long, and how much scheduling flexibility is available?",
      evidence: opening.location,
    });
  if (
    /not published|not disclosed|unknown|confirm|zone|states|placement|discrepancy/i.test(
      `${opening.compensation} ${opening.concerns}`,
    )
  )
    questions.push({
      question:
        "What published base salary band applies to my work location and senior level, separate from equity and bonus?",
      evidence: opening.compensation,
    });
  return questions.map((q) => ({ ...q, sourcePath: opening.sourcePath }));
}

export function parseOpenings(markdown: string): Opening[] {
  const sourceDate =
    markdown.match(/\*\*Scan completed:\*\*\s*(\S+)/)?.[1] ?? null;
  const sections = markdown.split(/^###\s+/m).slice(1);
  const seen = new Set<string>();
  const result: Opening[] = [];
  for (const section of sections) {
    const identity = section.match(
      /<!--\s*company_id:\s*([^;\s]+);\s*job_id:\s*([^\s]+)\s*-->/,
    );
    if (!identity)
      throw new Error(
        "Opening section has no stable company/requisition identity",
      );
    const company_id = identity[1],
      job_id = identity[2],
      id = `${company_id}:${job_id}`;
    if (seen.has(id)) throw new Error(`Duplicate opening identity: ${id}`);
    seen.add(id);
    const heading = section.split("\n")[0];
    const divider = heading.indexOf(" — ");
    if (divider < 0)
      throw new Error(
        `Opening heading does not identify company and title: ${id}`,
      );
    const fields = fieldsIn(section);
    const opening: Opening = {
      id,
      company_id,
      job_id,
      company: heading.slice(0, divider),
      title: heading.slice(divider + 3),
      url: safeUrl(fields["Job URL"] ?? ""),
      technical_fit: "",
      remote_fit: "",
      wlb_outlook: "",
      location: "",
      compensation: "",
      why: "",
      concerns: "",
      requirements: "",
      wlb_evidence: "",
      status: "",
      first_seen: isoDate(fields["First seen"] ?? ""),
      last_confirmed_open: isoDate(fields["Last confirmed open"] ?? ""),
      postingStatus: "not confirmed open",
      sourcePath: OPENINGS_PATH,
      sourceDate,
      hash: sha256(section.trim()),
    };
    for (const [label, key] of Object.entries(OPENING_FIELDS))
      (opening as Record<string, unknown>)[key] = fields[label] ?? "";
    const detailKeys = {
      technicalFit: ["Technical fit assessment", "technical_fit"],
      remoteFit: ["Remote fit assessment", "remote_fit"],
      wlbOutlook: ["WLB assessment", "wlb_outlook"],
    } as const;
    const details = Object.fromEntries(
      Object.entries(detailKeys).map(([key, [label, field]]) => [
        key,
        fields[label] && !/^unknown$/i.test(fields[label])
          ? fields[label]
          : opening[field] || "Unknown",
      ]),
    );
    const hasDetails = Object.values(detailKeys).some(
      ([label, field]) =>
        (fields[label] && !/^unknown$/i.test(fields[label])) ||
        !isOpeningAssessmentValue(opening[field]),
    );
    if (hasDetails && validOpeningAssessmentDetails(details))
      opening.assessmentDetails = details;
    for (const [, field] of Object.values(detailKeys))
      opening[field] = normalizeOpeningAssessment(opening[field]);
    const publication = fields["First published"];
    if (publication && validOpeningDate(publication))
      opening.first_published = publication;
    const publicationSource = safeUrl(fields["Publication source"] ?? "");
    const deadlineSource = safeUrl(fields["Deadline source"] ?? "");
    if (publicationSource || deadlineSource)
      opening.dateSources = {
        firstPublishedAt: publicationSource || null,
        deadline: deadlineSource || null,
      };
    const list = {
      location: fields["List location"],
      technicalFit: fields["List technical fit"],
      wlbOutlook: fields["List WLB outlook"],
      compensation: fields["List compensation"],
    };
    if (validOpeningListSummary(list)) opening.listSummary = list;
    if (!opening.url || !opening.title || !opening.compensation)
      throw new Error(`Incomplete opening: ${id}`);
    opening.deadline = isoDate(
      fields["Application deadline"] ??
        fields.Deadline ??
        section.match(
          /(?:application end date|deadline)\s*:\s*(\d{4}-\d{2}-\d{2})/i,
        )?.[1] ??
        "",
    );
    opening.deadlineProvenance = opening.deadline
      ? {
          path: OPENINGS_PATH,
          precision: "date",
          evidence: fields["Main concerns"] || fields.Deadline,
        }
      : null;
    opening.postingFingerprint = /^[a-f0-9]{64}$/.test(
      fields["Posting fingerprint"] ?? "",
    )
      ? fields["Posting fingerprint"]
      : "";
    opening.lastCheckedAt =
      fields["Last checked"] === "unknown"
        ? null
        : (fields["Last checked"] ?? null);
    opening.verificationNotes = fields["Verification notes"] ?? "";
    opening.reviewRequired = /^yes$/i.test(fields["Needs fit review"] ?? "");
    opening.assessmentDate = isoDate(fields["Assessment date"] ?? "");
    opening.postingStatus = /^closed$/i.test(fields["Posting status"] ?? "")
      ? "closed"
      : /not confirmed|unknown|unconfirmed/i.test(
            fields["Posting status"] ?? "",
          )
        ? "not confirmed open"
        : opening.last_confirmed_open
          ? "confirmed open at last scan"
          : "not confirmed open";
    const bands = salaryBands(opening.compensation);
    opening.salaryBands = bands;
    opening.salaryKind = bands.length
      ? "published"
      : /historical|earlier|previous|expired|reported|estimate|not a current quote/i.test(
            opening.compensation,
          )
        ? "historical / estimate"
        : "unknown";
    opening.recruiterQuestions = recruiterQuestions(opening);
    // A fresh verification timestamp or scanner NEW label is not a content change.
    opening.hash = sha256(
      JSON.stringify(
        Object.fromEntries(
          [
            "company_id",
            "job_id",
            "company",
            "title",
            "url",
            "location",
            "compensation",
            "technical_fit",
            "remote_fit",
            "wlb_outlook",
            "priority",
            "why",
            "concerns",
            "requirements",
            "wlb_evidence",
            "deadline",
            "postingStatus",
            "reviewRequired",
            "postingFingerprint",
            ...(opening.assessmentDetails ? ["assessmentDetails"] : []),
            ...(opening.first_published ? ["first_published"] : []),
          ].map((k) =>
            // Priority is retired, but its Markdown value stays in the fingerprint so
            // existing hashes (reviews, materials, summaries) do not all turn stale.
            k === "priority"
              ? [k, fields["Overall priority"] ?? ""]
              : [k, opening[k as keyof Opening] ?? null],
          ),
        ),
      ),
    );
    if (opening.assessmentDetails) opening.assessmentSourceHash = opening.hash;
    if (opening.listSummary) opening.listSummarySourceHash = opening.hash;
    openingSkillFields.bind(opening, openingSkillFields.parse(fields));
    result.push(opening);
  }
  if (
    !result.length &&
    !/(?:qualifying current openings:\*\*\s*0|no (?:qualifying |current )?openings)/i.test(
      markdown,
    )
  )
    throw new Error("No valid openings found");
  const declared = markdown.match(
    /\*\*Qualifying current openings:\*\*\s*(\d+)/i,
  )?.[1];
  if (declared !== undefined && Number(declared) !== result.length)
    throw new Error(
      `Opening summary declares ${declared} records but ${result.length} complete records were parsed. Possible partial write; preserve the previous valid import.`,
    );
  return result;
}
