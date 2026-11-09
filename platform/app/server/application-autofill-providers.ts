import { autofillHelperFile } from "./paths.js";
import {
  hostedApplication,
  type HostedApplicationIdentity,
} from "../shared/application-host.js";
import type {
  ApplicationAutofillRegistration,
  ApplicationAutofillRegistrations,
} from "./application-autofill-contract.js";
import { HttpError } from "./storage.js";
import { inspectGreenhouseApplication } from "./greenhouse-application-adapter.js";
import { loadGreenhouseApplication } from "./greenhouse-application-source.js";
import { autofillReader } from "./autofill/fetch.js";
import { prepareGreenhouseAutofill } from "./greenhouse-autofill-codec.js";

/** Only fully implemented providers belong here; URL recognition alone is not eligibility. */
export const applicationAutofillProviders = {
  greenhouse: {
    provider: "greenhouse",
    helperFile: autofillHelperFile("greenhouse"),
    journalLabel: "Greenhouse",
    acquire(store, identity, openingId, read) {
      return loadGreenhouseApplication(
        identity,
        read ?? autofillReader(store, openingId),
      );
    },
    inspect: inspectGreenhouseApplication,
    prepare: prepareGreenhouseAutofill,
  },
} satisfies ApplicationAutofillRegistrations;

/** Erase the mapped registration only after binding it to the selected provider. */
export function checkedAutofillRegistration(
  registration: NonNullable<
    ApplicationAutofillRegistrations[keyof ApplicationAutofillRegistrations]
  >,
  identity: HostedApplicationIdentity,
): ApplicationAutofillRegistration {
  if (identity.provider !== registration.provider)
    throw new HttpError(422, "Application provider does not match the loader.");
  return registration as ApplicationAutofillRegistration;
}

export function supportsApplicationAutofill(url: string): boolean {
  const identity = hostedApplication(url);
  return Boolean(identity && identity.provider === "greenhouse");
}
