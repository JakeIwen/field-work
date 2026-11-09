import type { ApplicationDocumentKind } from "./application-preparation.js";
import type {
  HostedApplicationIdentity,
  HostedApplicationProvider,
} from "./application-host.js";

export type ApplicationDomLocator =
  | { kind: "id"; id: string }
  | { kind: "css"; selector: string }
  | { kind: "name"; name: string; value?: string };

export type ApplicationSemanticRole =
  | "first-name"
  | "last-name"
  | "full-name"
  | "email"
  | "phone"
  | "address"
  | "city"
  | "state"
  | "postal-code"
  | "country"
  | "linkedin"
  | "github"
  | "website";

export type ApplicationFormSection = {
  id?: string;
  label?: string;
  instructions?: string;
};

export type ApplicationFieldOption = {
  value: string;
  label: string;
  locator?: ApplicationDomLocator;
  providerOptionId?: string;
};

/** Runtime readback, deliberately excluded from durable question identity. */
export type ApplicationFieldDomGuard = {
  label: string;
  description: string;
  sectionLabel: string;
  sectionInstructions: string;
  required: boolean;
  widget: string;
  options: { value: string; label: string }[];
};

const applicationScalarInputTypes = [
  "text",
  "number",
  "email",
  "tel",
  "url",
] as const;
export type ApplicationScalarInputType =
  (typeof applicationScalarInputTypes)[number];

export function applicationScalarInputType(
  widget: string,
): ApplicationScalarInputType | undefined {
  return applicationScalarInputTypes.find((type) => type === widget);
}

export type ApplicationFieldConstraints = {
  inputType?: ApplicationScalarInputType;
  /** Native attributes remain verbatim, including unsupported or invalid values. */
  min?: string;
  max?: string;
  step?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  conditions?: string;
  cardinality?: string;
};

type ApplicationFormFieldBase = {
  stableId: string;
  providerFieldId: string;
  locator: ApplicationDomLocator;
  label: string;
  description?: string;
  section?: ApplicationFormSection;
  required: boolean;
  semanticRole?: ApplicationSemanticRole;
  options?: ApplicationFieldOption[];
  constraints?: ApplicationFieldConstraints;
  providerType?: string;
  dom?: ApplicationFieldDomGuard;
};

export type ApplicationScalarField = ApplicationFormFieldBase & {
  kind: "text" | "textarea" | "select" | "single-choice";
  conditional?: false;
  handling: "scalar";
};

export type ApplicationManualField = ApplicationFormFieldBase & {
  kind:
    | "text"
    | "textarea"
    | "select"
    | "single-choice"
    | "multi-select"
    | "unknown";
  conditional?: boolean;
  handling: "manual";
  manualReason: string;
};

export type ApplicationFormField =
  ApplicationScalarField | ApplicationManualField;

export type ApplicationFileSlotKind = ApplicationDocumentKind | "other";
export type ApplicationFileSlot = {
  stableId: string;
  providerFieldId: string;
  kind: ApplicationFileSlotKind;
  locator: ApplicationDomLocator;
  label: string;
  required: boolean;
  accept?: string[];
  questionIdentity?: ApplicationFormQuestionIdentity;
  dom?: ApplicationFieldDomGuard;
};

export type ApplicationPostingLocation = {
  name?: string;
  country?: string;
  offices?: string[];
};

export type ApplicationCompensationPeriod =
  "hour" | "week" | "month" | "year" | "unknown";

export type ApplicationCompensationBasis = "base" | "unknown";

/** Published salary facts, normalized once by the provider; never annualized. */
export type ApplicationCompensation = {
  publishedText: string;
  /** False means published but not safely interpretable, never absent pay. */
  interpretable: boolean;
  ranges: {
    min: number | null;
    max: number | null;
    currency: string | null;
    basis: ApplicationCompensationBasis;
    period: ApplicationCompensationPeriod;
    publishedText: string;
    tier?: string;
  }[];
};

export function applicationCompensation(
  ranges: ApplicationCompensation["ranges"],
  publishedText: string,
): ApplicationCompensation {
  const interpretable =
    ranges.length > 0 &&
    ranges.every(
      (range) =>
        range.min !== null &&
        Number.isFinite(range.min) &&
        range.min > 0 &&
        range.max !== null &&
        Number.isFinite(range.max) &&
        range.max >= range.min &&
        range.currency !== null &&
        /^[A-Z]{3}$/.test(range.currency) &&
        range.basis === "base" &&
        range.period !== "unknown",
    );
  return { publishedText, interpretable, ranges };
}

export type ApplicationPostingFacts = {
  provider: HostedApplicationProvider;
  board: string;
  postingId: string;
  url: string;
  title: string;
  company: string;
  content: string;
  location?: ApplicationPostingLocation;
  /** Absent only when the provider publishes no compensation facts. */
  compensation?: ApplicationCompensation;
};

export type ApplicationDomEvidence = {
  url: string;
  content: string;
  contentHash: string;
  capturedAt: string;
};

export type ApplicationFormInspection = {
  identity: HostedApplicationIdentity;
  facts: ApplicationPostingFacts;
  fields: ApplicationFormField[];
  fileSlots: ApplicationFileSlot[];
  dom: ApplicationDomEvidence;
};

type ApplicationAttachmentBytes = {
  name: string;
  hash: string;
  mime: string;
  size: number;
  base64: string;
};

/** A generated Opening PDF (resume or cover letter). */
export type ApplicationDocumentAttachment = ApplicationFileSlot &
  ApplicationAttachmentBytes & { documentId: string };

/** A fixed workspace file, such as the recommendation letter. */
export type ApplicationSourceAttachment = ApplicationFileSlot &
  ApplicationAttachmentBytes & { sourcePath: string };

export type ApplicationExecutionAttachment =
  ApplicationDocumentAttachment | ApplicationSourceAttachment;

export type ApplicationAnswerSource = "profile" | "codex" | "user";

export type ApplicationAnswerProvenance = {
  source?: ApplicationAnswerSource;
  sourcePaths?: string[];
  caveats?: string[];
};

/** Immutable helper input. Locators execute controls; semantic IDs bind answers. */
export type ApplicationExecutionPlan = {
  identity: HostedApplicationIdentity;
  url?: string;
  fields: (ApplicationScalarField & {
    value: string;
    search?: string;
  } & ApplicationAnswerProvenance)[];
  review: { label: string; required: boolean; reason: string }[];
  requiredFields: ApplicationFormField[];
  observedFields?: ApplicationFormField[];
  fileSlots: ApplicationFileSlot[];
  attachments: ApplicationExecutionAttachment[];
};

export type ApplicationFormQuestionIdentity = {
  provider: HostedApplicationProvider;
  stableId: string;
  providerFieldId: string;
  label: string;
  kind: ApplicationFormField["kind"];
  required: boolean;
  description?: string;
  section?: ApplicationFormSection;
  options?: Pick<
    ApplicationFieldOption,
    "value" | "label" | "providerOptionId"
  >[];
  constraints?: ApplicationFieldConstraints;
  semanticRole?: ApplicationSemanticRole;
  providerType?: string;
  conditional?: boolean;
};

export function applicationFormQuestionIdentity(
  provider: HostedApplicationProvider,
  field: ApplicationFormField,
): ApplicationFormQuestionIdentity {
  return {
    provider,
    stableId: field.stableId,
    providerFieldId: field.providerFieldId,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(field.section ? { section: field.section } : {}),
    ...(field.options
      ? {
          options: field.options.map(({ value, label, providerOptionId }) => ({
            value,
            label,
            ...(providerOptionId ? { providerOptionId } : {}),
          })),
        }
      : {}),
    ...(field.constraints ? { constraints: field.constraints } : {}),
    ...(field.semanticRole ? { semanticRole: field.semanticRole } : {}),
    ...(field.providerType ? { providerType: field.providerType } : {}),
    ...(field.conditional !== undefined
      ? { conditional: field.conditional }
      : {}),
  };
}
