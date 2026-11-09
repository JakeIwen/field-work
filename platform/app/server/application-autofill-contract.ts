import type {
  ApplicationExecutionAttachment,
  ApplicationFileSlot,
  ApplicationFormInspection,
} from "../shared/application-form.js";
import type {
  HostedApplicationIdentity,
  HostedApplicationProvider,
} from "../shared/application-host.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";
import type { AutofillProfile } from "./autofill/plan-rules.js";
import type { CareersFetch } from "./careers/http.js";
import type { Store } from "./storage.js";

type ProviderIdentity = {
  [Provider in HostedApplicationProvider]: Extract<
    HostedApplicationIdentity,
    { provider: Provider }
  >;
};

export type ApplicationAutofillInspectionSource<
  Provider extends HostedApplicationProvider = HostedApplicationProvider,
> = {
  identity: ProviderIdentity[Provider];
  postingPayload: unknown;
  applicationUrl: string;
  applicationHtml: string;
  capturedAt: string;
};

export type AutofillPreparationContext<
  Provider extends HostedApplicationProvider = HostedApplicationProvider,
> = {
  store: Store;
  openingId: string;
  identity: ProviderIdentity[Provider];
  source: ApplicationAutofillInspectionSource<Provider>;
  inspection: ApplicationFormInspection;
  profile: AutofillProfile;
};

export type PackagedAutofill = {
  payload: object;
  review: AutofillRecord["review"];
  savedAttachments: NonNullable<AutofillRecord["attachments"]>;
  sourceAttachments: NonNullable<AutofillRecord["sourceAttachments"]>;
};

/** The codec owns wire shapes and their insertion order, including historical evidence. */
export type AutofillExecutionCodec = {
  sourceHashInput: object;
  evidenceExtras: object;
  package(
    attachments: ApplicationExecutionAttachment[],
    attachmentReview: AutofillRecord["review"],
  ): PackagedAutofill;
  evidencePlan(attachments: PackagedAutofill["savedAttachments"]): object;
};

export type PreparedAutofill = {
  answers: AutofillRecord["answers"];
  review: AutofillRecord["review"];
  dynamicQuestions: AutofillRecord["dynamicQuestions"];
  knowledgeHash: AutofillRecord["knowledgeHash"];
  documentPostingHash: string;
  attachmentRequirements: ApplicationFileSlot[];
  codec: AutofillExecutionCodec;
};

export type ApplicationAutofillRegistration<
  Provider extends HostedApplicationProvider = HostedApplicationProvider,
> = {
  provider: Provider;
  helperFile: URL;
  journalLabel: string;
  acquire(
    store: Store,
    identity: ProviderIdentity[Provider],
    openingId: string,
    read?: CareersFetch,
  ): Promise<ApplicationAutofillInspectionSource<Provider>>;
  inspect(
    source: ApplicationAutofillInspectionSource<Provider>,
  ): ApplicationFormInspection;
  prepare(context: AutofillPreparationContext<Provider>): PreparedAutofill;
};

export type ApplicationAutofillRegistrations = {
  [
    Provider in HostedApplicationProvider
  ]?: ApplicationAutofillRegistration<Provider>;
};
