import { withoutCountrySkipNote } from "../work-permission.js";

/** The parts of a form field the profile-answer rules read. */
export type ProfileField = {
  label: string;
  kind: "text" | "textarea" | "select";
  options: string[];
  description?: string;
  maxLength?: number;
};
export const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Equivalent self-identification labels only; never infer an identity from
 * gender, nationality or another demographic answer. Ambiguous options stay manual. */
const declinedDemographicOptions = [
  "Decline to self-identify",
  "Prefer not to say",
  "Prefer not to answer",
  "I don't wish to answer",
  "I do not wish to answer",
];

const demographicOptionGroups: Record<
  "gender" | "race" | "orientation" | "pronouns",
  string[][]
> = {
  gender: [
    ["Male", "Man"],
    ["Female", "Woman"],
    ["Non-binary", "Nonbinary", "Non binary"],
    ["Agender"],
    ["Genderfluid", "Gender fluid"],
    ["Genderqueer", "Gender queer"],
    declinedDemographicOptions,
  ],
  race: [
    [
      "White",
      "White / European background",
      "White / European",
      "White or European",
      "White or Caucasian",
      "Caucasian",
    ],
    [
      "Black",
      "Black or African American",
      "Black / African American",
      "African American",
      "Black / African-American / Black-British / Caribbean",
    ],
    ["Asian", "Asian background", "Asian or Asian American"],
    ["East Asian", "East Asian background"],
    ["South Asian", "South Asian background"],
    [
      "American Indian or Alaska Native",
      "American Indian / Alaska Native",
      "Alaska Native / American Indian / Indigenous/Aboriginal / Native American",
    ],
    [
      "Native Hawaiian or Other Pacific Islander",
      "Native Hawaiian / Other Pacific Islander",
    ],
    [
      "Hispanic or Latino",
      "Hispanic / Latinx",
      "Hispanic or Latinx",
      "Latino",
      "Latina",
      "Latinx",
    ],
    ["Middle Eastern or North African", "Middle Eastern / North African"],
    [
      "Two or more races",
      "Mixed or multiple backgrounds",
      "Multiracial",
      "Multiple races",
    ],
    declinedDemographicOptions,
  ],
  orientation: [
    [
      "Straight",
      "Heterosexual",
      "Heterosexual (straight)",
      "Straight / Heterosexual",
    ],
    ["Gay", "Homosexual"],
    ["Lesbian", "Lesbian / gay woman"],
    ["Bisexual", "Bi"],
    ["Asexual", "Ace"],
    ["Pansexual", "Pan"],
    ["Queer"],
    ["Questioning"],
    declinedDemographicOptions,
  ],
  pronouns: [
    ["He/Him/His", "He/Him", "He/His"],
    ["She/Her/Hers", "She/Her", "She/Hers"],
    ["They/Them/Theirs", "They/Them", "They/Theirs"],
    ["Ze/Zir/Zirs", "Ze/Zir"],
    ["Xe/Xem/Xyrs", "Xe/Xem"],
    ["She/They", "She/Her/They/Them"],
    ["He/They", "He/Him/They/Them"],
    ["Any pronouns"],
    declinedDemographicOptions,
  ],
};

export function demographicAliases(
  kind: keyof typeof demographicOptionGroups,
  value: unknown,
  hispanicLatino?: unknown,
): string[] {
  if (typeof value !== "string") return [];
  const group =
    demographicOptionGroups[kind].find((aliases) =>
      aliases.some((alias) => words(alias) === words(value)),
    ) ?? [];
  // A race alone does not establish whether the applicant is Hispanic/Latino.
  const nonHispanicRace =
    kind === "race" &&
    group.length > 0 &&
    group !== declinedDemographicOptions &&
    !group.includes("Hispanic or Latino") &&
    hispanicLatino === false;
  return nonHispanicRace
    ? [
        ...group,
        ...group.flatMap((alias) => [
          `${alias} (Not Hispanic or Latino)`,
          `${alias} (non-Hispanic)`,
        ]),
      ]
    : group;
}

/** The single option the test accepts (given its normalized words), else null. */
export function uniqueOption(
  options: string[],
  accepts: (option: string) => boolean,
): { value: string } | null {
  const matches = options.filter((o) => accepts(words(o)));
  return matches.length === 1 ? { value: matches[0] } : null;
}

/** Yes or No typed into a text field, or the form's one option starting with it. */
export function yesNoAnswer(
  field: ProfileField,
  answer: "Yes" | "No",
): { value: string } | null {
  if (field.kind !== "select") return { value: answer };
  const word = answer.toLowerCase();
  return uniqueOption(field.options, (o) => o.split(" ")[0] === word);
}
const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : null);

export function isUSOnlyPosting(location: unknown): boolean {
  return (
    typeof location === "string" &&
    /^(?:(?:remote|any location) )?(?:us|u s|usa|u s a|united states(?: of america)?)(?: remote)?$/.test(
      words(location),
    )
  );
}

export function referralNameNotApplicable(
  label: string,
  profile: any,
): boolean {
  const q = words(label);
  return (
    profile.discoverySource?.employeeReferral === false &&
    /\breferr(?:ed|er|al)\b/.test(q) &&
    /\b(?:employee|referrer)\b/.test(q) &&
    /\b(?:name|who)\b/.test(q)
  );
}

export function ageFromBirthDate(
  value: unknown,
  at = new Date(),
): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const born = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(born.getTime()) ||
    born.toISOString().slice(0, 10) !== value ||
    born > at
  )
    return null;
  let age = at.getUTCFullYear() - born.getUTCFullYear();
  if (
    at.getUTCMonth() < born.getUTCMonth() ||
    (at.getUTCMonth() === born.getUTCMonth() &&
      at.getUTCDate() < born.getUTCDate())
  )
    age--;
  return age <= 120 ? age : null;
}

/** "Are you at least 18 years old?" and equivalents, from the saved birth date. */
export function minimumAgeAnswer(q: string, profile: any): "Yes" | "No" | null {
  const atLeast =
    /^are you (?:at least (\d+)|(\d+)(?: years?)?(?: of age| old)? (?:or|and) (?:older|over|above))(?: years?(?: of age| old)?)?$/.exec(
      q,
    );
  const over =
    /^are you (?:over(?: the age of)?|older than) (\d+)(?: years?(?: of age| old)?)?$/.exec(
      q,
    );
  if (!atLeast && !over) return null;
  const age = ageFromBirthDate(profile.dateOfBirth);
  if (age === null) return null;
  return atLeast
    ? age >= Number(atLeast[1] ?? atLeast[2])
      ? "Yes"
      : "No"
    : age > Number(over![1])
      ? "Yes"
      : "No";
}

/** Match question meaning to confirmed facts, then select one compatible actual
 * option. No fuzzy string distance, new personal facts, or inferred diagnoses. */
export function profileQuestionAnswer(
  field: ProfileField,
  profile: any,
): { value: string } | null {
  const q = words(
      field.label.replace(
        /\((?:mark|select|check|choose) (?:all that apply|one|all applicable)\)/gi,
        "",
      ),
    ),
    d = profile.demographics ?? {};
  const subject = q
    .replace(
      /^(?:(?:what (?:is|are)|please (?:select|indicate|specify)) your|how (?:would|do) you describe your) /,
      "",
    )
    .replace(/^i identify my (.+) as$/, "$1");
  const choose = (value: string | null, aliases: string[] = []) => {
    if (!value) return null;
    if (field.kind !== "select") return { value };
    const allowed = [value, ...aliases].map(words);
    const matches = field.options.filter((o) => allowed.includes(words(o)));
    return matches.length === 1 ? { value: matches[0] } : null;
  };
  const select = (match: (option: string) => boolean) =>
    uniqueOption(field.options, match);

  if (
    /^(?:(?:what is|please enter) your )?current (?:employer|company)(?: name)?$/.test(
      q,
    )
  )
    return choose(profile.employmentHistory?.currentEmployer ?? null);
  if (
    /^(?:(?:what is|please enter) your )?current (?:job |position )?title$/.test(
      q,
    )
  )
    return choose(profile.employmentHistory?.currentJobTitle ?? null);

  if (
    /^(?:were|are) you referred by (?:a |an )?(?:current )?employee(?: of (?:the company|this company|.+))?$/.test(
      q,
    ) ||
    /^(?:did you receive|do you have) (?:an? )?(?:employee|internal) referral$/.test(
      q,
    )
  )
    return choose(yesNo(profile.discoverySource?.employeeReferral));

  if (
    /\b(?:country|nation)\b/.test(q) &&
    /\b(?:residence|residency|reside|live|living|based)\b/.test(q) &&
    !/\b(?:citizen|citizenship|nationality|birth|born|tax|taxes|authorized|eligible|relocate|willing|previous|previously)\b/.test(
      q,
    )
  ) {
    if (profile.location?.country === "US")
      return choose("United States", [
        "United States of America",
        "United States (USA)",
        "United States (US)",
        "USA",
        "US",
        "U.S.",
        "U.S.A.",
      ]);
  }

  if (
    /\benglish\b/.test(q) &&
    /\b(?:proficiency|proficient|fluency|fluent|communicating|communicate|speak)\b/.test(
      q,
    ) &&
    !/\b(?:test|score|certificate|certification|ielts|toefl|years|spanish|french|german)\b/.test(
      q,
    )
  ) {
    const level = profile.englishProficiency;
    if (
      ![
        "native-or-bilingual",
        "full-professional",
        "intermediate",
        "elementary",
      ].includes(level)
    )
      return null;
    if (/^(?:are you|can you|do you)\b/.test(q) && /\bfluent(?:ly)?\b/.test(q))
      return ["native-or-bilingual", "full-professional"].includes(level)
        ? choose("Yes")
        : null;
    const native = [
      "Native or Bilingual in English",
      "Native / Bilingual in English",
      "Native / bilingual proficiency",
      "Native or bilingual proficiency",
      "Native / Bilingual",
      "Native or Bilingual",
    ];
    const fluent = [
      "Full Proficiency (C1, C2)",
      "Full professional proficiency",
      "Full professional",
      "Professional working proficiency",
      "Fluent",
      "Advanced",
      "C1 / C2",
    ];
    if (level === "native-or-bilingual")
      return (
        choose(native[0], native.slice(1)) ?? choose(fluent[0], fluent.slice(1))
      );
    if (level === "full-professional")
      return choose(fluent[0], fluent.slice(1));
    return level === "intermediate"
      ? choose("Intermediate Proficiency (B1, B2)", ["Intermediate", "B1 / B2"])
      : choose("Elementary Proficiency (A1, A2)", [
          "Elementary",
          "Basic",
          "A1 / A2",
        ]);
  }

  // Work permission ignores every country (see work-permission.ts); reject
  // compound declarations, citizenship and inverse wording.
  const permission = words(withoutCountrySkipNote(field.label));
  const sponsorshipQuestion = words(
    withoutCountrySkipNote(field.label).replace(
      /\((?:e\.g\.,?|for example)[^)]*\)/gi,
      "",
    ),
  );
  if (
    /^(?:will|do|would) you (?:(?:now or in the future|now or will you in the future) )?(?:require|need) (?:(?:immigration|employment|work|visa|employer) )*sponsorship(?: (?:now or )?in the future)?$/.test(
      sponsorshipQuestion,
    )
  )
    return choose(yesNo(profile.requiresSponsorshipNowOrFuture));
  if (
    !/\b(?:citizen|citizenship|passport|restrictions|security clearance|proof|not|without)\b/.test(
      permission,
    )
  ) {
    if (
      /^(?:are you|do you)\b/.test(permission) &&
      /\b(?:eligible|authorized|authorised|permitted|right)\b/.test(
        permission,
      ) &&
      /\bwork\b/.test(permission) &&
      !/\b(?:sponsorship|sponsor|require|need|relocate|willing|and|or)\b/.test(
        permission,
      )
    )
      return choose(yesNo(profile.authorizedToWorkUS));
    if (
      /^(?:do you|will you|would you)\b/.test(permission) &&
      /\b(?:require|need)\b/.test(permission) &&
      /\b(?:sponsorship|sponsor|sponsored)\b/.test(permission) &&
      /\b(?:work|visa|employment|immigration)\b/.test(permission) &&
      (/\bfuture\b/.test(permission) ||
        profile.requiresSponsorshipNowOrFuture === false)
    )
      return choose(yesNo(profile.requiresSponsorshipNowOrFuture));
  }

  if (
    /^(?:are you|have you|were you|do you)\b/.test(q) &&
    /\b(?:current|currently|former|previous|previously|ever|past|before)\b/.test(
      q,
    ) &&
    /\bemployee\b|\bemployed (?:by|at|for)\b|\bwork(?:ed|ing) (?:at|for)\b/.test(
      q,
    ) &&
    !/\b(?:not|never|know|related|supervise|supervising|manage|managing|relative|relatives|family|spouse|partner|friend|friends|referral|referred|contractor|consultant|vendor|client|customer|applied|interviewed)\b/.test(
      q,
    )
  )
    return choose(yesNo(profile.employmentHistory?.currentOrFormerEmployee));

  if (
    /^gender(?: identity)?$/.test(subject) ||
    /^(?:how do you (?:describe|identify) your gender|which of the following best describes your gender(?: identity)?)$/.test(
      q,
    )
  )
    return choose(d.gender ?? null, demographicAliases("gender", d.gender));

  if (
    /^(?:cultural background|race|race(?: or)? ethnicity|racial background|racial(?: or)? ethnic (?:background|identity)|ethnic background|ethnicity)$/.test(
      subject,
    )
  ) {
    const race = d.race ?? d.culturalBackground ?? null;
    return choose(race, demographicAliases("race", race, d.hispanicLatino));
  }

  if (subject === "sexual orientation")
    return choose(
      d.sexualOrientation ?? null,
      demographicAliases("orientation", d.sexualOrientation),
    );
  if (subject === "pronouns" || /^which pronouns do you use$/.test(q))
    return choose(
      d.pronouns ?? null,
      demographicAliases("pronouns", d.pronouns),
    );
  if (/^(?:do you identify as|are you) transgender$/.test(q))
    return choose(yesNo(d.transgender));

  const disabilityQuestion =
    /^(?:disability(?: status)?(?: accessibility)?|do you (?:have|identify as (?:a person|someone) with) (?:a |any )?disabilit(?:y|ies)(?: of any kind visible or invisible)?|are you (?:a person|someone) with (?:a )?disabilit(?:y|ies))$/.test(
      q,
    );
  if (disabilityQuestion && typeof d.disability === "boolean") {
    return choose(
      yesNo(d.disability),
      d.disability
        ? [
            "Yes, I have a disability, or have had one in the past",
            "Yes, I have a disability",
            "I have a disability or long-term health condition that impacts my work or daily life",
            "I identify as a person with a disability",
          ]
        : [
            "No, I do not have a disability",
            "No, I do not have a disability and have not had one in the past",
            "I do not have a disability or long-term health condition",
          ],
    );
  }

  const minimumAge = minimumAgeAnswer(q, profile);
  if (minimumAge) return choose(minimumAge);
  if (
    /^(?:age|age (?:range|group|bracket)|what is your age(?: range| group)?|how old are you|please select your age (?:range|group|bracket))$/.test(
      q,
    )
  ) {
    const age = ageFromBirthDate(profile.dateOfBirth);
    if (age === null) return null;
    if (field.kind !== "select") return { value: String(age) };
    return select((option) => {
      const range = /^(\d+) (?:to )?(\d+)(?: years(?: old)?)?$/.exec(option);
      if (range) return age >= Number(range[1]) && age <= Number(range[2]);
      const under = /^(?:under|less than|younger than) (\d+)$/.exec(option);
      if (under) return age < Number(under[1]);
      const above = /^(\d+) (?:or older|and older|and over|or over|plus)$/.exec(
        option,
      );
      if (above) return age >= Number(above[1]);
      return option === String(age);
    });
  }
  return null;
}
