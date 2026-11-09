import { tunables } from "../shared/tunables.js";
import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { HttpError } from "./storage.js";
import type { Field } from "./suggest-autofill-rules.js";
import {
  attachDocumentReason,
  type AutofillReview,
} from "../shared/greenhouse-autofill.js";
const clean = (s: string) => s.replace(/\*/g, "").replace(/\s+/g, " ").trim();

type ApiQuestion = {
  id?: unknown;
  label: unknown;
  description?: unknown;
  required?: unknown;
  fields?: { name: string; values?: { label: unknown }[] }[];
  answer_options?: { label: unknown; free_form?: unknown }[];
};
export type GreenhouseApi = {
  content?: string;
  location?: unknown;
  offices?: unknown[];
  pay_input_ranges?: unknown[];
  id?: string | number;
  title?: string;
  absolute_url?: string;
  company_name?: unknown;
  questions?: ApiQuestion[];
  location_questions?: ApiQuestion[];
  compliance?: { questions?: ApiQuestion[] }[] | null;
  demographic_questions?: { questions?: ApiQuestion[] } | null;
};
type Definition = {
  options: string[];
  required: boolean;
  label: string;
  description?: string;
};
export type ControlGroup = {
  description?: string;
  name: string;
  ids: string[];
  label: string;
  required: boolean;
  choices: { id: string; label: string; kind: "checkbox" | "radio" }[];
};
type FormContext = {
  $: CheerioAPI;
  api: GreenhouseApi;
  definitions: Map<string, Definition>;
  fields: Field[];
  review: AutofillReview[];
  controlGroups: ControlGroup[];
  ids: Set<string>;
  answerMaxChars: number;
};

function collectDefinitions(
  api: GreenhouseApi,
  questions: ApiQuestion[],
): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const q of [
    ...questions,
    ...(api.location_questions ?? []),
    ...(api.compliance ?? []).flatMap((c) => c.questions ?? []),
  ]) {
    for (const f of q.fields ?? [])
      definitions.set(f.name, {
        options: (f.values ?? []).map((v) => clean(String(v.label))),
        required: q.required === true,
        label: clean(String(q.label)),
        ...(q.description
          ? { description: clean(load(String(q.description)).text()) }
          : {}),
      });
  }
  for (const q of api.demographic_questions?.questions ?? []) {
    definitions.set(String(q.id), {
      options: (q.answer_options ?? [])
        .filter((v) => !v.free_form)
        .map((v) => clean(String(v.label))),
      required: q.required === true,
      label: clean(String(q.label)),
      ...(q.description
        ? { description: clean(load(String(q.description)).text()) }
        : {}),
    });
  }
  return definitions;
}

function appendGroupedOrManualControl(
  context: FormContext,
  id: string,
  label: string,
  type: string | undefined,
  required: boolean,
  groupName: string,
) {
  const group = context.definitions.get(groupName);
  if (group && (type === "checkbox" || type === "radio")) {
    const existing = context.controlGroups.find((g) => g.name === groupName);
    if (existing) {
      existing.ids.push(id);
      existing.choices.push({ id, label, kind: type });
    } else {
      context.controlGroups.push({
        name: groupName,
        ids: [id],
        label: group.label,
        ...(group.description ? { description: group.description } : {}),
        required: group.required,
        choices: [{ id, label, kind: type }],
      });
      context.review.push({
        label: group.label,
        required: group.required,
        reason: "Choose the applicable option on the application page.",
      });
    }
    return;
  }
  context.review.push({
    label,
    required,
    reason: "Complete this control yourself.",
  });
}

function appendFormField(
  context: FormContext,
  node: Element,
  id: string,
  label: string,
  type: string | undefined,
  definition: Definition | undefined,
  required: boolean,
) {
  const e = context.$(node);
  const kind =
    node.tagName === "select" || e.attr("role") === "combobox"
      ? "select"
      : node.tagName === "textarea"
        ? "textarea"
        : "text";
  // Hosted Greenhouse derives this EEOC control from its race definition; it
  // is not returned as a separate API question. Exact options verified live.
  const options =
    id === "hispanic_ethnicity" &&
    label === "Are you Hispanic/Latino?" &&
    !definition
      ? ["Yes", "No", "Decline To Self Identify"]
      : (definition?.options ??
        (node.tagName === "select"
          ? e
              .find("option")
              .map((_i, o) => clean(context.$(o).text()))
              .get()
          : []));
  const rawMax = Number(e.attr("maxlength"));
  context.fields.push({
    id,
    label,
    kind,
    required,
    options,
    ...(definition?.description ? { description: definition.description } : {}),
    ...(context.api.demographic_questions?.questions?.some(
      (q) => String(q.id) === id,
    )
      ? { profileOnly: true }
      : {}),
    inputType: type,
    maxLength:
      Number.isInteger(rawMax) && rawMax > 0
        ? Math.min(rawMax, context.answerMaxChars)
        : Math.min(8000, context.answerMaxChars),
  });
}

function processFormControl(node: Element, context: FormContext) {
  const e = context.$(node),
    id = e.attr("id") as string,
    type = e.attr("type");
  const label = clean(
    context
      .$("#application-form label")
      .filter((_i, label) => context.$(label).attr("for") === id)
      .text(),
  );
  if (
    !label ||
    type === "hidden" ||
    type === "search" ||
    e.attr("aria-hidden") === "true"
  )
    return;
  if (context.ids.has(id))
    throw new HttpError(
      422,
      "The application has duplicate field identifiers; inspect it manually.",
    );
  context.ids.add(id);
  const definition = context.definitions.get(
    id === "candidate-location" ? "location" : id,
  );
  const required =
    definition?.required === true ||
    e.attr("aria-required") === "true" ||
    e.attr("required") !== undefined;
  if (type === "file") {
    // A custom upload's <label> is its hidden "Attach" button text.
    const uploadLabel = /^[\w-]+$/.test(id)
      ? clean(context.$(`#upload-label-${id}`).text())
      : "";
    context.review.push({
      label:
        id === "resume"
          ? "Resume/CV"
          : id === "cover_letter"
            ? "Cover letter"
            : uploadLabel || label,
      required,
      reason: attachDocumentReason,
    });
    return;
  }
  if (["checkbox", "radio", "submit", "button"].includes(type ?? "")) {
    appendGroupedOrManualControl(
      context,
      id,
      label,
      type,
      required,
      e.attr("name") ?? "",
    );
    return;
  }
  appendFormField(context, node, id, label, type, definition, required);
}

function verifyForm(context: FormContext) {
  if (
    !context.fields.some((f) => f.id === "first_name") ||
    !context.fields.some((f) => f.id === "email")
  )
    throw new HttpError(422, "The application form could not be verified.");
  if (
    context.fields.some((f) => f.id === "hispanic_ethnicity") &&
    !context.fields.some((f) => f.id === "race") &&
    context.definitions.has("race")
  ) {
    const race = context.definitions.get("race") as Definition;
    context.fields.push({
      id: "race",
      label: "Please identify your race",
      kind: "select",
      required: false,
      options: race.options,
      conditional: true,
    });
  }
  if (context.fields.length > 150)
    throw new HttpError(
      422,
      "This application has too many fields for autofill.",
    );
}

/** Match API options to the controls actually present in the hosted form. */
export function greenhouseForm(
  html: string,
  api: GreenhouseApi,
  answerMaxChars: number = tunables["autofill.answerMaxChars"].default,
) {
  if (!Array.isArray(api?.questions) || !api.questions.length)
    throw new HttpError(
      422,
      "Greenhouse did not return application questions.",
    );
  const $ = load(html);
  if ($("#application-form").length !== 1)
    throw new HttpError(
      422,
      "This posting has no supported Greenhouse application form. It may be closed or use an embedded form.",
    );
  const context: FormContext = {
    $,
    api,
    definitions: collectDefinitions(api, api.questions),
    fields: [],
    review: [],
    controlGroups: [],
    ids: new Set<string>(),
    answerMaxChars,
  };
  $(
    "#application-form input[id], #application-form textarea[id], #application-form select[id]",
  ).each((_i, node) => processFormControl(node, context));
  verifyForm(context);
  return {
    fields: context.fields,
    review: context.review,
    controlGroups: context.controlGroups,
  };
}
