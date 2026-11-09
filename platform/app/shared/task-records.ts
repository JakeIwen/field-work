import type {
  ApplicationDocumentKind,
  DocumentOverflow,
} from "./application-preparation";
import type {
  Application,
  Company,
  Document,
  Opening,
  TaskStatus,
} from "./types";
import type { AutofillQuestion } from "./greenhouse-autofill";
import type { TaskActivity } from "./task-activity";

export type OverflowRecoveryOwner = {
  preparationId: string;
  cancelled?: boolean;
};

export type OverflowRequest = { turnId?: string } & (
  | {
      kind: "repair";
      preparationId: string;
      failedTurnId: string;
      cancelled?: boolean;
    }
  | { kind: "independent" }
);

export type TaskPreset =
  | "opening-research"
  | "questions"
  | "posting-application"
  | "posting-resume"
  | "posting-cover-letter"
  | "resume-revision"
  | "cover-letter"
  | "job-fit"
  | "company-research"
  | "careers-refresh"
  | "follow-up-email";

export type ArtifactRecord = {
  path: string;
  hash: string;
  size: number;
  format: string;
  documentId?: string;
  sourcePath?: string;
  privacy?: string;
  addedAt?: string;
  at?: string;
};
export type ValidationCheck = { name: string; status: string; output?: string };
export type BundleValidation = {
  status: string;
  at?: string;
  checks?: ValidationCheck[];
  artifacts?: ArtifactRecord[];
  sourceHashes?: Record<string, string>;
};
export type Bundle = {
  id: string;
  privateOnly?: boolean;
  writingRuleHashes?: Partial<Record<ApplicationDocumentKind, string>>;
  version: number;
  status?: string;
  scope?: string;
  createdAt?: string;
  sourceHashes: Record<string, string>;
  paths: string[];
  versionDir?: string | null;
  master?: string;
  evidence?: string;
  artifacts?: ArtifactRecord[];
  validation?: BundleValidation | null;
  promotion?: {
    status: string;
    at?: string;
    version?: string;
    versionDirectory?: string;
    transactionId?: string;
  };
};
export type TaskPosting = {
  kind?: string;
  url?: string;
  finalUrl?: string;
  title?: string;
  text?: string;
  hash?: string;
  fetchedAt?: string;
  capturedAt?: string | null;
};
export type TaskManifest = {
  taskId?: string;
  schemaVersion?: number;
  createdAt?: string;
  purpose?: string;
  paths: string[];
  sourceHashes: Record<string, string>;
  profileHash?: string;
  route?: string;
  scope?: string;
  target?: { scope: string; master?: string; versionDir?: string | null };
  excludedDocuments?: { id?: string; path?: string; reason?: string }[];
  missingOptionalSources?: string[];
  reference?: {
    id?: string;
    title?: string;
    hash?: string;
    updatedAt?: string | number;
    importedAt?: string;
  };
  posting?: TaskPosting | null;
  context?: {
    opening?: Opening | null;
    company?: Company | null;
    application?: Application | null;
  };
  instruction?: string;
  instructions?: string;
};
export type TaskMessage = {
  clientRequestId?: string;
  id?: string;
  role: string;
  text: string;
  at?: string;
  turnId?: string;
  delivery?: string;
  model?: string;
  effort?: string;
};
export type TaskRequest = {
  requestId: string;
  id?: string | number;
  threadId?: string;
  method: string;
  params?: Record<string, unknown>;
};
export type TaskEvent = {
  method: string;
  selection?: import("./model-selection.js").ModelSelection;
  turnId?: string;
  at?: string;
  threadId?: string | null;
  requestId?: string;
  request?: TaskRequest;
  status?: string;
  reason?: string | null;
  message?: string;
  params?: {
    turn?: { id?: string; status?: string };
    // Adapter payloads vary by protocol method and are not task status records.
    [key: string]: unknown;
  };
};
export type DocumentResult = {
  status: string;
  turnId?: string;
  startedAt?: string;
  createdAt?: string;
  completedAt?: string;
  documentIds?: string[];
  error?: string;
  validation?: BundleValidation;
  inputHashes?: Record<string, string>;
  overflow?: DocumentOverflow;
  ownershipUnknown?: boolean;
};
export type AutofillContext = {
  url: string;
  openingHash: string;
  sourceHash?: string;
  knowledgeHash: string;
  profileHash?: string;
  profileSnapshot?: Record<string, unknown>;
  postingCountry?: string | null;
  locationContext?: {
    location: string;
    offices: { name: string; location: string }[];
    countries: string[];
    unresolvedLabels: string[];
    conflicting: boolean;
    applicationCountry: string | null;
    remote: boolean;
    preferredCountry: string | null;
    countryMismatch: boolean;
  };
  questions: AutofillQuestion[];
  posting?: TaskPosting;
  recordId?: string;
  documentIds?: string[];
};
export type ApplicationAnswer = {
  key: string;
  answer: string;
  notApplicable?: boolean;
  needsInput?: boolean;
  sourcePaths: string[];
  caveats: string[];
  manualReviewRequired?: boolean;
  reviewReason?: string;
  profileKeys?: string[];
};
type TaskBase = {
  id: string;
  status: TaskStatus;
  version: number;
  title?: string;
  prompt: string;
  context: {
    documentIds?: string[];
    openingId?: string;
    companyId?: string;
    applicationId?: string;
  };
  mode?: string;
  clientRequestId?: string | null;
  threadId?: string | null;
  /** Previous providers’ threads, oldest first; current threadId remains the active owner. */
  previousThreadIds?: string[];
  activeTurnId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  messages: TaskMessage[];
  eventCount?: number;
  thread?: unknown;
  pendingRequests?: TaskRequest[];
  bundle?: Bundle;
  manifest?: TaskManifest;
  model?: string;
  effort?: string;
  modelPolicy?: string;
  error?: string | null;
  liveText?: string;
  /** Reduced from adapter events by server/task-activity.ts; absent on tasks that predate it. */
  activity?: TaskActivity;
  fixture?: boolean;
  preparationId?: string;
  /** Historical metadata from the removed draft-review feature; new tasks never set it. */
  review?: import("./model-selection.js").ModelSelection & {
    target: "cover-letter" | "follow-up-email";
    trigger: "auto" | "manual";
    sourceId: string;
  };
  overflowRequests?: Record<string, OverflowRequest>;
  // Legacy snapshots retain history but cannot authorize a turn's publication.
  overflowRecovery?: OverflowRecoveryOwner & { failedTurnId: string };
  overflowRecoveryTurns?: Record<string, OverflowRecoveryOwner | null>;
  preparationOpeningHash?: string;
  preparationPostingHash?: string;
  returnedArtifacts?: Omit<ArtifactRecord, "size" | "format">[];
  posting?: TaskPosting | null;
  postingLabel?: string;
  documentResult?: DocumentResult;
  documentRuns?: Record<string, DocumentResult>;
  usage?: {
    total?: Record<string, number>;
    last?: Record<string, number>;
    modelContextWindow?: number;
  };
};
type TaskFeatures = {
  "opening-research": {
    researchResult?: unknown;
    publishedResearchHash?: string;
    matchedBy?: "companyTitle" | "jobId" | "url";
    greenhouseDecision?: {
      decision: "add" | "excluded" | "deferred";
      reason?: string;
      sources?: string[];
      softwareAssessment?: string;
      remoteAssessment?: string;
      fitAssessment?: string;
    };
    importUrl?: string;
    importStatus?: string;
    openingId?: string;
    fetchError?: string;
    greenhousePull?: {
      runId: string;
      candidateId: string;
      candidate?: unknown;
      instructions?: string;
    };
  };
  questions: {
    autofillContext?: AutofillContext;
    autofillResult?: {
      status: string;
      turnId?: string;
      scriptId?: string;
      error?: string;
    };
    autofillDraft?: { turnId?: string; answers: ApplicationAnswer[] } | null;
  };
};
type FeatureKeys = {
  [P in keyof TaskFeatures]: keyof TaskFeatures[P];
}[keyof TaskFeatures];
type TaskVariant<P extends TaskPreset> = TaskBase & {
  preset: P;
} & (P extends keyof TaskFeatures
    ? TaskFeatures[P] & {
        [K in Exclude<FeatureKeys, keyof TaskFeatures[P]>]?: never;
      }
    : { [K in FeatureKeys]?: never });
export type Task = { [P in TaskPreset]: TaskVariant<P> }[TaskPreset];

type Summarize<T extends Task> = T extends Task
  ? Omit<T, "eventCount" | "thread" | "autofillContext" | "greenhousePull"> & {
      eventCount: number;
      events?: never;
      thread?: never;
      autofillContext?: NonNullable<T["autofillContext"]> extends never
        ? never
        : Omit<NonNullable<T["autofillContext"]>, "profileSnapshot"> & {
            profileSnapshot?: never;
          };
      greenhousePull?: NonNullable<T["greenhousePull"]> extends never
        ? never
        : Omit<NonNullable<T["greenhousePull"]>, "candidate"> & {
            candidate?: never;
          };
    }
  : never;
export type TaskSummary = Summarize<Task>;

export type JournalEntry = {
  id: string;
  at: string;
  type: string;
  message: string;
  entityId?: string;
  applicationId?: string;
  recordId?: string;
  details?: unknown;
  /** Set when the user archives the entry in Settings → Records & activity. */
  archivedAt?: string;
};
export type SavedFilter = {
  id: string;
  name: string;
  filters: Record<
    string,
    string | string[] | boolean | import("./opening-skills").OpeningSkillFilter
  >;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};
export type ApplicationPackage = {
  id: string;
  at: string;
  source?: string;
  scriptId?: string;
  scriptHash?: string;
  evidenceHash?: string;
  documents: (Pick<Document, "id" | "hash"> &
    Partial<
      Pick<
        Document,
        "path" | "name" | "privacy" | "format" | "version" | "kind"
      >
    >)[];
};
