import { words, yesNoAnswer, type ProfileField } from "./profile-answers.js";

// Address and full-time residence answers come only from the saved location
// and applicationLocation.residesInUSFullTime fields, never inferred facts.

const ask = "(?:(?:what is|please (?:provide|enter|list|share)) )?(?:your )?";
const fullAddress = new RegExp(
  `^${ask}(?:(?:current|permanent|legal|home|mailing|residential|physical|full|primary) )*address(?: of residence)?$`,
);
const streetAddress = new RegExp(
  `^${ask}(?:(?:current|permanent|legal|home|mailing|residential) )*(?:street address|street|address line 1|address 1)$`,
);
const zip = new RegExp(
  `^${ask}(?:(?:current|home|residential|mailing) )*(?:zip|zipcode|zip code|postal code|postcode|zip postal code|postal zip code)(?: of (?:your )?(?:current )?residence)?$`,
);
const us = "(?:the )?(?:united states(?: of america)?|us|usa|u s(?: a)?)";
const fullTimeResidence = [
  new RegExp(
    `^(?:will|do|are) you (?:currently )?(?:be )?(?:reside|residing|live|living|based) (?:full time )?in ${us}(?: full time)?(?: (?:while|during) .+)?$`,
  ),
  new RegExp(`^are you (?:currently )?a full time resident of ${us}$`),
];

type Address = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
};

function savedAddress(profile: any): Address | null {
  const l = profile?.location;
  if (l?.country !== "US") return null;
  const parts = [l.streetAddress, l.city, l.state, l.postalCode];
  return parts.every((p) => typeof p === "string" && p.trim())
    ? {
        street: l.streetAddress.trim(),
        city: l.city.trim(),
        state: l.state.trim(),
        postalCode: l.postalCode.trim(),
      }
    : null;
}

type Answer = { value: string } | null;

function zipAnswer(field: ProfileField, profile: any): Answer {
  const postal = profile?.location?.postalCode;
  if (field.kind === "select" || profile?.location?.country !== "US")
    return null;
  if (typeof postal !== "string" || !/^\d{5}(?:-\d{4})?$/.test(postal))
    return null;
  // A five-character field takes the ZIP without its +4 extension.
  return {
    value:
      field.maxLength !== undefined && field.maxLength < postal.length
        ? postal.slice(0, 5)
        : postal,
  };
}

const addressAnswer =
  (format: (address: Address) => string) =>
  (field: ProfileField, profile: any): Answer => {
    const address = field.kind === "select" ? null : savedAddress(profile);
    return address ? { value: format(address) } : null;
  };

// Ordered: the first rule whose question pattern matches answers the field.
const rules: {
  fact: string;
  matches: (q: string) => boolean;
  answer: (field: ProfileField, profile: any) => Answer;
}[] = [
  {
    fact: "location.postalCode",
    matches: (q) => zip.test(q),
    answer: zipAnswer,
  },
  {
    fact: "location.streetAddress",
    matches: (q) => streetAddress.test(q),
    answer: addressAnswer((a) => a.street),
  },
  {
    fact: "location.streetAddress",
    matches: (q) => fullAddress.test(q),
    answer: addressAnswer(
      (a) => `${a.street}, ${a.city}, ${a.state} ${a.postalCode}`,
    ),
  },
  {
    fact: "applicationLocation.residesInUSFullTime",
    matches: (q) => fullTimeResidence.some((pattern) => pattern.test(q)),
    answer: (field, profile) =>
      profile?.applicationLocation?.residesInUSFullTime === true
        ? yesNoAnswer(field, "Yes")
        : null,
  },
];

const ruleFor = (label: string) => {
  const q = words(label);
  return rules.find((rule) => rule.matches(q));
};

/** The saved fact a question about the address, ZIP or full-time US residence asks for. */
export function residenceFact(label: string): string | null {
  return ruleFor(label)?.fact ?? null;
}

export function residenceAnswer(field: ProfileField, profile: any): Answer {
  return ruleFor(field.label)?.answer(field, profile) ?? null;
}
