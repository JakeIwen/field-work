import { readFileSync } from "node:fs";
import type { ApplicationPostingFacts } from "../../shared/application-form.js";
import type { AutofillRecord } from "../../shared/greenhouse-autofill.js";
import { HttpError, sha256, type Store } from "../storage.js";

export type AutofillEvidence = {
  api?: Record<string, unknown>;
  facts?: ApplicationPostingFacts;
  profile?: unknown;
  plan?: { url?: string };
};

/** Bridge normalized facts to existing confirmed-fact rules, not to a fake form. */
export function postingRuleFacts(facts: ApplicationPostingFacts) {
  const countryNames: Record<string, string> = {
    US: "United States",
    CA: "Canada",
    GB: "United Kingdom",
  };
  const country = facts.location?.country;
  return {
    title: facts.title,
    company_name: facts.company,
    content: facts.content,
    location: { name: facts.location?.name ?? "" },
    offices: [
      ...(facts.location?.offices ?? []),
      ...(country ? [countryNames[country] ?? country] : []),
    ].map((name) => ({ name, location: "" })),
    // Null distinguishes normalized absent pay from legacy Greenhouse prose reads.
    compensation: facts.compensation ?? null,
  };
}

export function evidenceRuleFacts(evidence: AutofillEvidence) {
  // Preserve captured GH payloads exactly: historical country and pay interpretation
  // must not be silently rewritten by a newer normalization algorithm.
  return evidence.facts?.provider !== "greenhouse" && evidence.facts
    ? postingRuleFacts(evidence.facts)
    : (evidence.api ?? {});
}

export function evidencePosting(
  record: Pick<AutofillRecord, "url" | "title" | "createdAt" | "provider">,
  evidence: AutofillEvidence,
) {
  const content =
    evidence.facts?.provider !== "greenhouse" && evidence.facts
      ? evidence.facts.content
      : evidence.api?.content;
  if (typeof content !== "string")
    throw new HttpError(
      409,
      "The saved posting evidence is missing. Inspect the application again.",
    );
  return {
    kind: `${record.provider ?? evidence.facts?.provider ?? "greenhouse"}-current`,
    url: record.url,
    title: record.title,
    text: content,
    hash: sha256(content),
    fetchedAt: record.createdAt,
  };
}

export function readAutofillEvidence(
  store: Store,
  record: Pick<AutofillRecord, "evidenceHash">,
): AutofillEvidence {
  const bytes = readFileSync(store.objectPath(record.evidenceHash), "utf8");
  if (sha256(bytes) !== record.evidenceHash)
    throw new HttpError(
      409,
      "Saved application evidence failed its integrity check.",
    );
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(409, "The saved application evidence is invalid.");
  return value as AutofillEvidence;
}
