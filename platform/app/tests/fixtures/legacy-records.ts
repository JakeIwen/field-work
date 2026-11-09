import type { Records } from "../../server/records.js";
import type {
  ApplicationPackage,
  TaskMessage,
  TaskEvent,
} from "../../shared/task-records.js";

export const legacyBundleDefaults = {
  id: "",
  version: 0,
  sourceHashes: {},
  paths: [],
} satisfies Records["bundle"];

type LegacyBundleOverrides = Partial<Records["bundle"]>;

export function legacyBundle(
  overrides: LegacyBundleOverrides = {},
): Records["bundle"] {
  return structuredClone({ ...legacyBundleDefaults, ...overrides });
}

export const legacyTaskMessageDefaults = {
  role: "",
  text: "",
} satisfies TaskMessage;

export const legacyTaskDefaults = {
  id: "",
  status: "idle",
  version: 0,
  prompt: "",
  context: {},
  messages: [],
  events: [],
  preset: "questions",
} satisfies Records["task"] & { events: TaskEvent[] };

type LegacyTaskOverrides<T = Records["task"]> = T extends Records["task"]
  ? Omit<Partial<T>, "bundle" | "messages" | "preset"> & {
      events?: TaskEvent[];
      bundle?: LegacyBundleOverrides;
      messages?: Partial<TaskMessage>[];
    } & (T["preset"] extends "questions"
        ? { preset?: "questions" }
        : Pick<T, "preset">)
  : never;

function taskMessages(messages: Partial<TaskMessage>[] | undefined) {
  return (messages ?? []).map((message) => ({
    ...structuredClone(legacyTaskMessageDefaults),
    ...message,
  }));
}

export function legacyTask(
  overrides: LegacyTaskOverrides = {},
): Records["task"] & { events: TaskEvent[] } {
  const { bundle, messages, ...rest } = overrides;
  if (bundle === undefined)
    return {
      ...structuredClone(legacyTaskDefaults),
      ...rest,
      messages: taskMessages(messages),
    };
  return {
    ...structuredClone(legacyTaskDefaults),
    ...rest,
    messages: taskMessages(messages),
    bundle: legacyBundle(bundle),
  };
}

export const legacyApplicationPackageDocumentDefaults = {
  id: "",
  hash: "",
} satisfies ApplicationPackage["documents"][number];

export const legacyApplicationPackageDefaults = {
  id: "",
  at: "",
  documents: [],
} satisfies ApplicationPackage;

type LegacyApplicationPackageDocumentOverrides = Partial<
  ApplicationPackage["documents"][number]
>;
type LegacyApplicationPackageOverrides = Omit<
  Partial<ApplicationPackage>,
  "documents"
> & {
  documents?: LegacyApplicationPackageDocumentOverrides[];
};

type LegacyApplicationOverrides = Omit<
  Partial<Records["application"]>,
  "packages"
> & {
  packages?: LegacyApplicationPackageOverrides[];
};

function legacyApplicationPackage(
  overrides: LegacyApplicationPackageOverrides = {},
): ApplicationPackage {
  const { documents, ...rest } = overrides;
  return {
    ...structuredClone(legacyApplicationPackageDefaults),
    ...rest,
    documents: (documents ?? []).map((document) => ({
      ...structuredClone(legacyApplicationPackageDocumentDefaults),
      ...document,
    })),
  };
}

export const legacyApplicationDefaults = {
  id: "",
  openingId: "",
  status: "considering",
  nextAction: "",
  followUp: "",
  contacts: "",
  notes: "",
  documentIds: [],
  version: 0,
  createdAt: "",
  updatedAt: "",
} satisfies Records["application"];

export function legacyApplication(
  overrides: LegacyApplicationOverrides = {},
): Records["application"] {
  const { packages, ...rest } = overrides;
  return {
    ...structuredClone(legacyApplicationDefaults),
    ...rest,
    ...(packages === undefined
      ? {}
      : { packages: packages.map((pack) => legacyApplicationPackage(pack)) }),
  };
}

export const legacyAutofillAttachmentDefaults = {
  id: "",
  label: "",
  documentId: "",
  name: "",
  hash: "",
  mime: "",
  size: 0,
} satisfies NonNullable<Records["application_autofill"]["attachments"]>[number];

type LegacyAutofillAttachmentOverrides = Partial<
  NonNullable<Records["application_autofill"]["attachments"]>[number]
>;
type LegacyAutofillOverrides = Omit<
  Partial<Records["application_autofill"]>,
  "attachments"
> & {
  attachments?: LegacyAutofillAttachmentOverrides[];
};

export const legacyAutofillDefaults = {
  id: "",
  openingId: "",
  version: 0,
  createdAt: "",
  url: "",
  title: "",
  openingHash: "",
  sourceHash: "",
  profileHash: "",
  helperHash: "",
  scriptHash: "",
  evidenceHash: "",
  answers: [],
  review: [],
} satisfies Records["application_autofill"];

export function legacyAutofill(
  overrides: LegacyAutofillOverrides = {},
): Records["application_autofill"] {
  const { attachments, ...rest } = overrides;
  return {
    ...structuredClone(legacyAutofillDefaults),
    ...rest,
    ...(attachments === undefined
      ? {}
      : {
          attachments: attachments.map((attachment) => ({
            ...structuredClone(legacyAutofillAttachmentDefaults),
            ...attachment,
          })),
        }),
  };
}

export const legacyDocumentDefaults = {
  id: "",
  logicalId: "",
  path: "",
  hash: "",
  name: "",
  kind: "",
  scope: "",
  company: null,
  version: "",
  versionNumber: 0,
  status: "",
  privacy: "",
  format: "",
  authoredDate: null,
  dateProvenance: "",
  modifiedAt: "",
  text: "",
} satisfies Records["cache_document"];

export function legacyDocument(
  overrides: Partial<Records["cache_document"]> = {},
): Records["cache_document"] {
  return structuredClone({ ...legacyDocumentDefaults, ...overrides });
}

export const legacyOpeningDefaults = {
  id: "",
  company_id: "",
  company: "",
  job_id: "",
  title: "",
  url: "",
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
  first_seen: null,
  last_confirmed_open: null,
  postingStatus: "",
  sourcePath: "",
  sourceDate: null,
  hash: "",
} satisfies Records["cache_opening"];

export function legacyOpening(
  overrides: Partial<Records["cache_opening"]> = {},
): Records["cache_opening"] {
  return structuredClone({ ...legacyOpeningDefaults, ...overrides });
}

export const legacyCompanyDefaults = {
  id: "",
  name: "",
  sourcePath: "",
  sourceDate: null,
  fields: {},
  text: "",
  hash: "",
} satisfies Records["cache_company"];

export function legacyCompany(
  overrides: Partial<Records["cache_company"]> = {},
): Records["cache_company"] {
  return structuredClone({ ...legacyCompanyDefaults, ...overrides });
}

export const legacyValidationRunDefaults = {
  id: "",
  status: "",
  startedAt: "",
  total: 0,
  completed: 0,
  counts: { open: 0, closed: 0, unknown: 0 },
  targets: [],
  results: [],
} satisfies Records["opening_validation_run"];

export function legacyValidationRun(
  overrides: Partial<Records["opening_validation_run"]> = {},
): Records["opening_validation_run"] {
  return structuredClone({ ...legacyValidationRunDefaults, ...overrides });
}
