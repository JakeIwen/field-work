import type { OpeningFormCheck } from "../shared/opening-form-check.js";
import type { GreenhouseReviewMemory } from "./opening-pull/review-memory.js";
import type {
  ModelPreferences,
  EffortPreferences,
} from "../shared/codex-models.js";
import type {
  Application,
  Company,
  CompanyContact,
  Document,
  ImportResult,
  Opening,
  Personal,
} from "../shared/types.js";
import type {
  ApplicationAnswer,
  Bundle,
  JournalEntry,
  SavedFilter,
  Task,
  TaskPosting,
} from "../shared/task-records.js";
import type { ApplicationPreparation } from "../shared/application-preparation.js";
import type {
  ApplicationAnswerReview,
  AutofillRecord,
} from "../shared/greenhouse-autofill.js";
import type { OpeningValidation } from "../shared/opening-availability.js";
import type { FitCriteria } from "../shared/fit-criteria.js";
import type { Schedules } from "../shared/schedules.js";
import type { PullRun, PullCandidate } from "./greenhouse-pull.js";
import type { CompanyScan } from "./careers/providers.js";
import type { ApplicationFollowUp } from "../shared/follow-up-email.js";
import type {
  EmployerReply,
  GmailPreferences,
  GmailScan,
} from "../shared/gmail.js";

export type Settings =
  import("../shared/greenhouse-company-filter.js").GreenhouseCompanyFilterSettings &
    import("../shared/greenhouse-pull.js").GreenhouseReviewSettings &
    import("../shared/greenhouse-guidance.js").GreenhouseSearchTermPoolSettings &
    import("../shared/preparation-settings.js").PreparationSettings &
    import("../shared/tunables.js").TunableSettings &
    import("../shared/palette.js").PaletteSettings & {
      greenhousePacingRate?: number;
      greenhousePacingPenaltyMs?: number;
      greenhousePolicy?: import("../shared/greenhouse-policy.js").GreenhousePullPolicy;
      greenhouseGuidance?: import("../shared/greenhouse-guidance.js").GreenhouseGuidance;
      codexModels?: ModelPreferences;
      codexEfforts?: EffortPreferences;
      timezone: string;
      version: number;
      schedules?: Schedules;
      fitCriteria?: FitCriteria;
      updatedAt?: string;
    };
export type ReferenceContext = {
  id: string;
  title?: string;
  hash: string;
  text: string;
  updatedAt?: string | number;
  importedAt?: string;
  limits?: string;
  historicalWorkspace?: string;
  messages: { role: string; text: string }[];
};
export type CareerScan = {
  id: string;
  requestId: string;
  mode: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  companies: Company[];
  sourceHashes: Record<string, string>;
  rows: {
    company_id: string;
    company: string;
    status: string;
    result: CompanyScan | null;
  }[];
  poolHash: string;
  completed: number;
  total: number;
  fitCriteria: FitCriteria;
  error?: string | null;
};
export type ValidationRun = {
  id: string;
  status: string;
  startedAt: string;
  updatedAt?: string;
  completedAt?: string;
  total: number;
  completed: number;
  counts: { open: number; closed: number; unknown: number };
  visibilityChanges?: { hidden: number; restored: number };
  targets: { id: string; url: string }[];
  results: OpeningValidation[];
  current?: string;
  error?: string;
};
export type Records = {
  employer_reply: EmployerReply;
  gmail_preferences: GmailPreferences;
  gmail_scan: GmailScan;
  deleted_record: {
    id: string;
    kind: string;
    identityHash: string;
    deletedAt: string;
  };
  task: Task;
  bundle: Bundle;
  application: Application;
  application_preparation: ApplicationPreparation;
  application_autofill: AutofillRecord & { documentIds?: string[] };
  application_answer_set: {
    id: string;
    taskId: string;
    openingId: string;
    url: string;
    knowledgeHash: string;
    createdAt: string;
    answers: ApplicationAnswer[];
    sourceHashes: Record<string, string>;
    profileHash?: string;
  };
  application_answer_review: ApplicationAnswerReview;
  application_follow_up: ApplicationFollowUp;
  cache_document: Document;
  cache_opening: Opening;
  cache_company: Company;
  custom_opening: Opening;
  custom_company: Company;
  generated_document: Document;
  personal: Personal;
  settings: Settings;
  meta: ImportResult & { previousImportedAt?: string };
  journal: JournalEntry;
  filter: SavedFilter;
  career_scan: CareerScan;
  company_contact: CompanyContact;
  reference_context: ReferenceContext;
  posting_preview: TaskPosting & { id: string; text: string };
  opening_form_check: OpeningFormCheck;
  opening_validation: OpeningValidation;
  opening_validation_run: ValidationRun;
  greenhouse_browser: { id?: string; tabId: string };
  greenhouse_guidance_history: import("../shared/greenhouse-guidance.js").GreenhouseGuidanceHistoryEntry;
  greenhouse_review_memory: GreenhouseReviewMemory;
  greenhouse_pull_run: PullRun;
  greenhouse_pull_candidate: PullCandidate;
};
export type VersionedKind = {
  [K in keyof Records]: Records[K] extends { version: number } ? K : never;
}[keyof Records];
