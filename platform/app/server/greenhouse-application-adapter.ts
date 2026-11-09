import { load, type CheerioAPI } from "cheerio";
import type { ApplicationAutofillInspectionSource } from "./application-autofill-contract.js";
import type {
  ApplicationFileSlot,
  ApplicationFormInspection,
  ApplicationFormField,
  ApplicationPostingFacts,
} from "../shared/application-form.js";
import type { GreenhouseHostedApplication } from "../shared/application-host.js";
import { greenhouseForm, type GreenhouseApi } from "./greenhouse-form.js";
import { HttpError, sha256 } from "./storage.js";

export function greenhouseApi(value: unknown): GreenhouseApi {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(422, "Greenhouse returned a different or invalid job.");
  const api = value as GreenhouseApi;
  const groups = [
    api.questions,
    api.location_questions,
    ...(Array.isArray(api.compliance)
      ? api.compliance.map((c) => c?.questions)
      : []),
    api.demographic_questions?.questions,
  ];
  for (const questions of groups) {
    if (questions === undefined) continue;
    if (
      !Array.isArray(questions) ||
      questions.some(
        (q) =>
          !q ||
          typeof q !== "object" ||
          typeof q.label !== "string" ||
          (q.fields !== undefined &&
            (!Array.isArray(q.fields) ||
              q.fields.some(
                (f) =>
                  !f ||
                  typeof f.name !== "string" ||
                  (f.values !== undefined &&
                    (!Array.isArray(f.values) ||
                      f.values.some((v) => !v || typeof v.label !== "string"))),
              ))) ||
          (q.answer_options !== undefined &&
            (!Array.isArray(q.answer_options) ||
              q.answer_options.some((o) => !o || typeof o.label !== "string"))),
      )
    )
      throw new HttpError(422, "Greenhouse returned an invalid question list.");
  }
  // Greenhouse sends `compliance: null` for jobs without EEO questions.
  if (api.compliance != null && !Array.isArray(api.compliance))
    throw new HttpError(422, "Greenhouse returned an invalid question list.");
  return api;
}

function postingFacts(
  identity: GreenhouseHostedApplication,
  payload: unknown,
): ApplicationPostingFacts {
  const api = greenhouseApi(payload);
  if (
    String(api.id) !== identity.postingId ||
    typeof api.title !== "string" ||
    !api.title.trim()
  )
    throw new HttpError(422, "Greenhouse returned a different or invalid job.");
  const location =
    api.location &&
    typeof api.location === "object" &&
    "name" in api.location &&
    typeof api.location.name === "string"
      ? api.location.name
      : undefined;
  return {
    provider: "greenhouse",
    board: identity.board,
    postingId: identity.postingId,
    url: identity.url,
    title: api.title,
    company: typeof api.company_name === "string" ? api.company_name : "",
    content: api.content ?? "",
    ...(location ? { location: { name: location } } : {}),
  };
}

/** A labelled file input inside its Greenhouse upload group. */
function uploadControl($: CheerioAPI, id: string) {
  const input = $(`#application-form #${id}`);
  if (input.length !== 1 || input.attr("type") !== "file") return undefined;
  const group = input.closest(".file-upload");
  const label = group
    .find(`#upload-label-${id}`)
    .text()
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return label ? { input, group, label } : undefined;
}

function fileSlots(html: string): ApplicationFileSlot[] {
  const $ = load(html);
  const documents = (["resume", "cover_letter"] as const).flatMap(
    (id): ApplicationFileSlot[] => {
      const control = uploadControl($, id);
      if (!control) return [];
      return [
        {
          stableId: id,
          providerFieldId: id,
          locator: { kind: "id", id },
          label: control.label,
          kind: id === "resume" ? "resume" : "cover-letter",
          required:
            id === "resume" || control.input.attr("required") !== undefined,
        },
      ];
    },
  );
  const custom = $('#application-form input[type="file"][id^="question_"]')
    .map((_i, input) => $(input).attr("id"))
    .get()
    .filter((id) => /^question_\d+$/.test(id))
    .flatMap((id): ApplicationFileSlot[] => {
      const control = uploadControl($, id);
      if (!control) return [];
      const accept = (control.input.attr("accept") ?? "")
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);
      return [
        {
          stableId: id,
          providerFieldId: id,
          locator: { kind: "id", id },
          label: control.label,
          kind: "other",
          required:
            control.group.attr("aria-required") === "true" ||
            control.input.attr("required") !== undefined,
          ...(accept.length ? { accept } : {}),
        },
      ];
    });
  return [...documents, ...custom];
}

export function inspectGreenhouseApplication(
  source: ApplicationAutofillInspectionSource<"greenhouse">,
): ApplicationFormInspection {
  const facts = postingFacts(source.identity, source.postingPayload);
  const form = greenhouseForm(
    source.applicationHtml,
    greenhouseApi(source.postingPayload),
  );
  const fields: ApplicationFormField[] = form.fields.map((f) => {
    const base = {
      stableId: f.id,
      providerFieldId: f.id,
      locator: { kind: "id" as const, id: f.id },
      label: f.label,
      kind: f.kind,
      required: f.required,
      description: f.description,
      options: f.options.map((label) => ({ label, value: label })),
      constraints: { maxLength: f.maxLength },
    };
    return f.conditional
      ? {
          ...base,
          handling: "manual",
          conditional: true,
          manualReason: "Conditional field",
        }
      : { ...base, handling: "scalar" };
  });
  return {
    identity: source.identity,
    facts,
    fields,
    fileSlots: fileSlots(source.applicationHtml),
    dom: {
      url: source.applicationUrl,
      content: source.applicationHtml,
      contentHash: sha256(source.applicationHtml),
      capturedAt: source.capturedAt,
    },
  };
}
