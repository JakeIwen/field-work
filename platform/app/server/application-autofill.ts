import { tunable } from "./tunables.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openingErrorMessage } from "../shared/opening-error.js";
import {
  hostedApplication,
  sameHostedApplication,
  type HostedApplicationIdentity,
} from "../shared/application-host.js";
import type { ApplicationFormInspection } from "../shared/application-form.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";
import { formDocumentSlots } from "../shared/application-preparation.js";
import {
  assertGenerationActive,
  beginGeneration,
  generationFailure,
} from "./generation-control.js";
import { Store, HttpError, sha256, atomicWrite, now } from "./storage.js";
import type { CareersFetch } from "./careers/http.js";
import { readAutofillProfile } from "./autofill/profile.js";
import {
  applicationAutofillProviders,
  checkedAutofillRegistration,
} from "./application-autofill-providers.js";
import type {
  ApplicationAutofillInspectionSource,
  ApplicationAutofillRegistration,
  ApplicationAutofillRegistrations,
  PreparedAutofill,
  PackagedAutofill,
} from "./application-autofill-contract.js";
import { packageApplicationAttachments } from "./autofill/attachments.js";
import { referenceLetterAttachments } from "./autofill/reference-letter.js";

type PackageOptions = { documentIds: string[]; preparationId?: string };
type Context = {
  store: Store;
  openingId: string;
  opening: NonNullable<ReturnType<Store["opening"]>>;
  identity: HostedApplicationIdentity;
  provider: ApplicationAutofillRegistration;
  profile: ReturnType<typeof readAutofillProfile>["profile"];
  profileHash: string;
  preparation?: { id: string; status: string; phase: string };
  packageOptions?: PackageOptions;
};

function generationContext(
  store: Store,
  openingId: string,
  packageOptions: PackageOptions | undefined,
  providers: ApplicationAutofillRegistrations,
): Context {
  const opening = store.opening(openingId);
  if (!opening) throw new HttpError(404, "Opening not found");
  const identity = hostedApplication(opening.url);
  const provider = identity && providers[identity.provider];
  if (!identity || !provider)
    throw new HttpError(
      422,
      "Use a supported hosted application URL to generate an autofill script.",
    );
  const { profile, hash: profileHash } = readAutofillProfile(store);
  const preparation = packageOptions?.preparationId
    ? store.get("application_preparation", packageOptions.preparationId)
    : undefined;
  return {
    store,
    openingId,
    opening,
    identity,
    provider: checkedAutofillRegistration(provider, identity),
    profile,
    profileHash,
    packageOptions,
    ...(preparation
      ? {
          preparation: {
            id: preparation.id,
            status: preparation.status,
            phase: preparation.phase,
          },
        }
      : {}),
  };
}

function assertCurrent(context: Context) {
  assertGenerationActive(context.store);
  const current = context.store.opening(context.openingId);
  if (
    readAutofillProfile(context.store).hash !== context.profileHash ||
    current?.hash !== context.opening.hash ||
    current?.url !== context.opening.url
  )
    throw new HttpError(
      409,
      "Your answers or opening changed during generation. Generate again using the current data.",
    );
  if (context.preparation) {
    const run = context.store.get(
      "application_preparation",
      context.preparation.id,
    );
    if (
      !run ||
      run.status !== context.preparation.status ||
      run.phase !== context.preparation.phase
    )
      throw new HttpError(
        409,
        "Preparation changed or was removed. No script was published.",
      );
  }
}

function verifyInspection(
  store: Store,
  identity: HostedApplicationIdentity,
  inspection: ApplicationFormInspection,
) {
  if (
    !sameHostedApplication(identity.url, inspection.identity.url) ||
    !sameHostedApplication(identity.url, inspection.dom.url) ||
    !sameHostedApplication(identity.url, inspection.facts.url) ||
    inspection.facts.provider !== identity.provider ||
    inspection.facts.board !== identity.board ||
    inspection.facts.postingId !== identity.postingId ||
    typeof inspection.facts.title !== "string" ||
    !inspection.facts.title.trim() ||
    typeof inspection.facts.content !== "string" ||
    typeof inspection.facts.company !== "string" ||
    sha256(inspection.dom.content) !== inspection.dom.contentHash
  )
    throw new HttpError(
      422,
      "Application identity or captured form evidence could not be verified.",
    );
  const fields = [...inspection.fields, ...inspection.fileSlots];
  const ids = new Set(fields.map((field) => field.stableId));
  const unidentifiedQuestion = inspection.fields.some(
    (field) =>
      ![
        field.label,
        field.description,
        field.section?.label,
        field.section?.instructions,
      ].some((value) => value?.trim()),
  );
  if (
    fields.length > tunable(store, "autofill.maxFormFields") ||
    ids.size !== fields.length ||
    fields.some(
      (field) =>
        !field.stableId ||
        !field.providerFieldId ||
        typeof field.required !== "boolean",
    ) ||
    unidentifiedQuestion ||
    inspection.fileSlots.some((slot) => !slot.label.trim())
  )
    throw new HttpError(
      422,
      "Application fields are unsupported or have duplicate identities.",
    );
}

function packagePlan(
  context: Context,
  prepared: PreparedAutofill,
): PackagedAutofill {
  const { attachments, review } = packageApplicationAttachments(
    context.store,
    context.openingId,
    context.packageOptions?.documentIds ?? [],
    prepared.documentPostingHash,
    prepared.attachmentRequirements,
  );
  return prepared.codec.package(
    [
      ...attachments,
      ...referenceLetterAttachments(
        context.store,
        prepared.attachmentRequirements,
      ),
    ],
    review,
  );
}

function persistAutofillObjects(
  context: Context,
  source: ApplicationAutofillInspectionSource,
  inspection: ApplicationFormInspection,
  prepared: PreparedAutofill,
  materials: PackagedAutofill,
) {
  const { payload, savedAttachments } = materials;
  const helper = readFileSync(context.provider.helperFile, "utf8").trim();
  const sourceHash = sha256(JSON.stringify(prepared.codec.sourceHashInput));
  const script = `// Fieldwork autofill. Review the form before submitting.\n${helper}(${JSON.stringify(payload, null, 2)});\n`;
  const evidence = JSON.stringify(
    {
      fetchedAt: source.capturedAt,
      ...prepared.codec.evidenceExtras,
      provider: context.identity.provider,
      facts: inspection.facts,
      form: inspection,
      url: source.applicationUrl,
      postingUrl: context.identity.url,
      html: source.applicationHtml,
      plan: prepared.codec.evidencePlan(savedAttachments),
      profile: context.profile,
      profileHash: context.profileHash,
      sourceHash,
    },
    null,
    2,
  );
  assertCurrent(context);
  const scriptHash = sha256(script),
    evidenceHash = sha256(evidence);
  atomicWrite(context.store.objectPath(scriptHash), script);
  atomicWrite(context.store.objectPath(evidenceHash), evidence);
  return {
    sourceHash,
    helperHash: sha256(helper),
    scriptHash,
    evidenceHash,
    savedAttachments,
  };
}

function persistGeneration(
  context: Context,
  source: ApplicationAutofillInspectionSource,
  inspection: ApplicationFormInspection,
  prepared: PreparedAutofill,
) {
  const materials = packagePlan(context, prepared);
  const { sourceHash, helperHash, scriptHash, evidenceHash, savedAttachments } =
    persistAutofillObjects(context, source, inspection, prepared, materials);
  const version =
    Math.max(
      0,
      ...context.store
        .list("application_autofill")
        .filter((record) => record.openingId === context.openingId)
        .map((record) => record.version),
    ) + 1;
  const record: AutofillRecord = {
    id: randomUUID(),
    openingId: context.openingId,
    provider: context.identity.provider,
    version,
    createdAt: now(),
    url: source.applicationUrl,
    title: inspection.facts.title,
    openingHash: context.opening.hash,
    sourceHash,
    profileHash: context.profileHash,
    helperHash,
    scriptHash,
    evidenceHash,
    answers: prepared.answers,
    review: materials.review,
    attachments: savedAttachments,
    ...(materials.sourceAttachments.length
      ? { sourceAttachments: materials.sourceAttachments }
      : {}),
    preparationId: context.packageOptions?.preparationId,
    documentPostingHash: prepared.documentPostingHash,
    documentSlots: formDocumentSlots(inspection.fileSlots),
    dynamicQuestions: prepared.dynamicQuestions,
    knowledgeHash: prepared.knowledgeHash,
  };
  assertCurrent(context);
  context.store.put("application_autofill", record.id, record);
  return record;
}

/** Shared inspection, answer, attachment and immutable publication pipeline. */
export async function generateAutofill(
  store: Store,
  openingId: string,
  read?: CareersFetch,
  packageOptions?: PackageOptions,
  providers: ApplicationAutofillRegistrations = applicationAutofillProviders,
) {
  const finish = beginGeneration(store);
  try {
    const context = generationContext(
      store,
      openingId,
      packageOptions,
      providers,
    );
    const source = await context.provider.acquire(
      store,
      context.identity,
      openingId,
      read,
    );
    assertCurrent(context);
    if (
      !sameHostedApplication(context.identity.url, source.applicationUrl) ||
      !sameHostedApplication(context.identity.url, source.identity.url)
    )
      throw new HttpError(
        422,
        "The application redirected to a different posting. No script was saved.",
      );
    if (source.identity.provider !== context.provider.provider)
      throw new HttpError(
        422,
        "Application provider does not match the inspector.",
      );
    const inspection = context.provider.inspect(source);
    verifyInspection(store, context.identity, inspection);
    const prepared = context.provider.prepare({
      store,
      openingId,
      identity: context.identity,
      source,
      inspection,
      profile: context.profile,
    });
    return persistGeneration(context, source, inspection, prepared);
  } catch (error) {
    const failure = generationFailure(store, error);
    failure.message = openingErrorMessage(
      store.opening(openingId) ?? { id: openingId },
      failure,
    );
    throw failure;
  } finally {
    finish();
  }
}
