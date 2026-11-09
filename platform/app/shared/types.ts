import type { ModelPreferences, EffortPreferences } from "./codex-models.js";
import type {
  ApplicationPackage,
  JournalEntry,
  SavedFilter,
} from "./task-records";
export type { Task, TaskSummary, TaskPreset, Bundle } from "./task-records";
import type { OpeningAssessmentDetails } from "./opening-assessments";
import type { OpeningListSummary } from "./opening-list";
import type { OpeningSkills } from "./opening-skills";
import type {
  ApplicationPreparation,
  AnswersOnlyAutofillCount,
} from "./application-preparation";
import type { OpeningValidation } from "./opening-availability";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting for input"
  | "waiting for approval"
  | "completed"
  | "failed"
  | "interrupted"
  | "disconnected"
  | "idle"
  | "handoff"
  | "unavailable";

export type ApplicationStatus =
  | "considering"
  | "preparing"
  | "ready"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export type { PreparationStatus } from "./application-preparation";

export const isTaskTurnActive = (status: TaskStatus | undefined) =>
  status === "queued" || status === "running";

export const isTaskWaiting = (status: TaskStatus | undefined) =>
  status === "waiting for input" || status === "waiting for approval";

export const isTaskBusy = (status: TaskStatus | undefined) =>
  isTaskTurnActive(status) || isTaskWaiting(status);

export const isTaskTurnUnsettled = (status: TaskStatus | undefined) =>
  isTaskTurnActive(status) || status === "disconnected";

export type Personal = {
  id?: string;
  monitoring?: boolean;
  pendingWatchlist?: boolean;
  preferred?: boolean;
  updatedAt?: string;

  version: number;
  saved?: boolean;
  bookmarked?: boolean;
  dismissed?: boolean;
  reviewedHash?: string;
  notes?: string;
  interest?: string;
  nextAction?: string;
  followUp?: string;
};
export type CompanyContact = {
  companyId: string;
  companyName?: string;
  taskId?: string;
  contactInfo: string;
  contactType: string;
  sourceUrl: string;
  checkedAt: string | null;
  notes?: string;
  researchPath?: string;
};
export type Company = {
  addedAt?: string;
  contactInfo?: string;
  contact?: CompanyContact;
  personalCompany?: boolean;
  sourceMissing?: boolean;
  retained?: boolean;
  firstImportedAt?: string;
  lastAbsentFromSourceAt?: string;

  id: string;
  name: string;
  sourcePath: string;
  sourceDate: string | null;
  fields: Record<string, string>;
  text: string;
  scan?: {
    result: string;
    notes: string;
    sources: string[];
  };
  hash: string;
};
export type Opening = {
  pullSource?: import("./opening-pull.js").OpeningPullSource;
  greenhouse?: {
    board?: string;
    publicId?: string;
    internalJobId?: string | number | null;
    aliases?: string[];
    apiUrl?: string;
    pullId?: string;
  };
  greenhouseAliases?: (
    | string
    | {
        publicJobId?: string;
        id?: string;
        jobId?: string;
        url?: string;
        urls?: string[];
      }
  )[];
  alternateUrls?: string[];
  identityHistory?: {
    firstSeen: string | null;
    lastSeen: string | null;
    lastConfirmedListed: string | null;
    qualification?: unknown;
  };
  urlAliases?: string[];
  // Imported Markdown research and the client sorter address source-defined fields dynamically.
  [key: string]: unknown;
  salaryBands?: {
    min: number;
    max: number;
    currency?: string;
    text?: string;
    basis?: string;
  }[];
  salaryKind?: string;
  reviewRequired?: boolean;
  verificationNotes?: string;
  sources?: string[];

  contactInfo?: string;
  contact?: CompanyContact;
  personalOpening?: boolean;
  retained?: boolean;
  sourceMissing?: boolean;
  lastCheckedAt?: string | null;
  lastAbsentFromSourceAt?: string;
  applicationDate?: string | null;
  applicationStartedAt?: string | null;
  applicationStatus?: ApplicationStatus | null;
  description?: string;
  posting?: import("./task-records").TaskPosting;

  id: string;
  company_id: string;
  company: string;
  job_id: string;
  title: string;
  url: string;
  technical_fit: string;
  remote_fit: string;
  wlb_outlook: string;
  assessmentDetails?: OpeningAssessmentDetails;
  assessmentSourceHash?: string;
  listSummary?: OpeningListSummary;
  listSummarySourceHash?: string;
  /** Agent-classified required/preferred technologies, bound to the posting hash like listSummary. */
  skills?: OpeningSkills;
  skillsSourceHash?: string;
  first_published?: string | null;
  createdAt?: string;
  firstImportedAt?: string;
  dateSources?: { firstPublishedAt?: string | null; deadline?: string | null };
  location: string;
  compensation: string;
  why: string;
  concerns: string;
  requirements: string;
  wlb_evidence: string;
  status: string;
  first_seen: string | null;
  last_confirmed_open: string | null;
  deadline?: string | null;
  postingStatus: string;
  validation?: OpeningValidation;
  sourcePath: string;
  sourceDate: string | null;
  hash: string;
  discrepancy?: unknown[];
};
export type Document = {
  writingRuleHash?: string;
  writingRuleWarning?: string;
  validation?: string;
  generatedTurnId?: string;
  originalName?: string;
  bundleId?: string;
  origin?: string;
  createdAt?: string;
  generatedBy?: string;
  /** Historical provenance from the removed document-review feature. */
  review?: import("./model-selection.js").ModelSelection & {
    trigger: "auto" | "manual";
    sourceDocumentId: string;
  };
  revisionNotes?: string;
  privacyProvenance?: string;
  statusProvenance?: string;
  textSourcePath?: string;
  textProvenance?: string;
  previousVersionIds?: string[];

  availableInSource?: boolean;
  immutableCopyAvailable?: boolean;
  sourceVerifiedAt?: string;
  preferred?: boolean;
  sourceHash?: string;
  generated?: boolean;
  generatedAt?: string;
  taskId?: string;
  turnId?: string;
  postingHash?: string;
  postingLabel?: string;
  postingUrl?: string | null;
  openingId?: string | null;
  applicationId?: string | null;
  sourcePath?: string;
  originalVersion?: string;
  namingVersion?: number;
  preparationId?: string;
  openingHash?: string;
  inputHashes?: Record<string, string>;
  usedInApplications?: {
    id: string;
    openingId: string;
    submittedAt?: string;
  }[];

  id: string;
  logicalId: string;
  path: string;
  hash: string;
  name: string;
  kind: string;
  scope: string;
  company: string | null;
  version: string;
  versionNumber: number;
  status: string;
  privacy: string;
  format: string;
  authoredDate: string | null;
  dateProvenance: string;
  modifiedAt: string;
  firstImportedAt?: string;
  text: string;
  notesPath?: string;
  relatedIds?: string[];
};
export type HealthIssue = {
  id: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  paths?: string[];
  details?: unknown;
};
export type ImportResult = {
  companies: Company[];
  openings: Opening[];
  documents: Document[];
  health: HealthIssue[];
  scan: {
    timestamp: string | null;
    seenCount: number;
    failedCompanies: string[];
    // Scan-state JSON includes source/provider-specific metadata beyond the common counters.
    [key: string]: unknown;
  };
  sourceHashes: Record<string, string>;
  validSections: { companies: boolean; openings: boolean; documents: boolean };
  importedAt: string;
};
export type Application = {
  employerReplyUpdate?: {
    replyId: string;
    receivedAt: string;
    version: number;
    nextAction?: string;
  };
  employerContact?: CompanyContact;
  company?: string;
  title?: string;
  id: string;
  openingId: string;
  status: ApplicationStatus;
  nextAction: string;
  followUp: string;
  contacts: string;
  notes: string;
  documentIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  submissionSource?: "autofill-copy";
  startedAt?: string;
  applicationDate?: string;
  employerContactInfo?: string;
  packages?: ApplicationPackage[];
};
export type AppState = Omit<ImportResult, "validSections" | "importedAt"> & {
  validSections: Partial<ImportResult["validSections"]>;
  importedAt: string | null;
  greenhousePull?: import("./greenhouse-pull").GreenhousePullSummary | null;
  openingGenerationCounts?: Record<string, number>;
  // Optional while clients can connect to a backend predating resume-aware skills.
  knownSkills?: string[];
  // "Finish on the application" items left on each Opening's latest autofill script.
  openingAutofillFinishCounts?: Record<string, number>;
  openingFormChecks?: Record<
    string,
    import("./opening-form-check.js").OpeningFormQuestionCounts
  >;
  openingAutofillAnswerCounts?: Record<string, AnswersOnlyAutofillCount>;
  // Latest saved script identity, independent of journal retention and preparation.
  openingAutofillScriptIds?: Record<string, string>;
  preparations?: ApplicationPreparation[];
  followUps?: import("./follow-up-email").ApplicationFollowUpSummary[];
  personal: Record<string, Personal>;
  applications: Application[];
  tasks: import("./task-records").TaskSummary[];
  journal: JournalEntry[];
  // Settings include persisted schedules, fit criteria, and extension values consumed by the client.
  settings: import("./greenhouse-company-filter.js").GreenhouseCompanyFilterSettings &
    import("./greenhouse-pull.js").GreenhouseReviewSettings &
    import("./greenhouse-guidance.js").GreenhouseSearchTermPoolSettings &
    import("./preparation-settings.js").PreparationSettings &
    import("./tunables.js").TunableSettings &
    import("./palette.js").PaletteSettings & {
      greenhousePacingRate?: number;
      greenhousePacingPenaltyMs?: number;
      greenhouseGuidance?: import("./greenhouse-guidance.js").GreenhouseGuidance;
      greenhousePolicy?: import("./greenhouse-policy.js").GreenhousePullPolicy;
      timezone: string;
      codexModels?: ModelPreferences;
      codexEfforts?: EffortPreferences;
      version?: number;
      [key: string]: unknown;
    };
  savedFilters: SavedFilter[];
  csrfToken?: string;
  // The state route adds subsystem snapshots to the base Store state.
  [key: string]: unknown;
};
