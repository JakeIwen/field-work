import type { ApplicationSemanticRole } from "../shared/application-form.js";
import { usStates as states, statesNamedInList } from "../shared/us-states.js";
import {
  demographicAliases,
  profileQuestionAnswer,
} from "./autofill/profile-answers.js";
import {
  isProfessionalReferenceQuestion,
  professionalReferenceAnswer,
} from "./autofill/references.js";
import { employeeConnectionAnswer } from "./autofill/employee-connections.js";
import { residenceAnswer } from "./autofill/residence.js";
import { educationDegreeLabel } from "./autofill/resume-facts.js";
import {
  confirmedEducation,
  primaryEducation,
  educationDateAnswer,
} from "./autofill/education.js";

export type Field = {
  semanticRole?: ApplicationSemanticRole;
  id: string;
  label: string;
  kind: "text" | "textarea" | "select";
  required: boolean;
  options: string[];
  maxLength?: number;
  conditional?: boolean;
  inputType?: string;
  profileOnly?: boolean;
  description?: string;
};

type Suggestion = { value: string; search?: string };
type Profile = {
  [key: string]: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  preferredFirstName?: unknown;
  school?: unknown;
  education?: unknown;
  linkedIn?: unknown;
  github?: unknown;
  website?: unknown;
  location?: {
    city?: unknown;
    state?: unknown;
    country?: unknown;
  };
  resumeFacts?: {
    education?: {
      degree: string;
      discipline: string;
      endYear: string;
    } | null;
    experience?: { minYears: number; maxYears: number } | null;
    highestDegreeRank?: number;
  } | null;
  authorizedToWorkUS?: unknown;
  requiresSponsorshipNowOrFuture?: unknown;
  demographics?: Record<string, unknown>;
};

type RuleContext = {
  field: Field;
  q: string;
  profile: Profile;
  d: Record<string, unknown>;
  company: string;
  companyQuestion: string;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  residency: string | null;
};
type Rule = {
  name: string;
  matcher: (context: RuleContext) => boolean;
  resolver: (context: RuleContext) => Suggestion | null;
};

const clean = (s: string) => s.replace(/\*/g, "").replace(/\s+/g, " ").trim();
const lower = (s: string) => clean(s).toLowerCase().replace(/[‘’]/g, "'");
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 2000
    ? v.trim()
    : null;

const yesNo = (v: unknown) => (v === true ? "Yes" : v === false ? "No" : null);
const stateCode = (value: string | null) =>
  value
    ? (Object.keys(states).find(
        (code) =>
          lower(code) === lower(value) || lower(states[code]) === lower(value),
      ) ?? null)
    : null;
const requestedStateCode = (value: string | null) =>
  value
    ? (Object.keys(states).find(
        (code) => lower(code) === value || lower(states[code]) === value,
      ) ?? null)
    : null;
const residencyTarget = (q: string) =>
  /^(?:do you (?:currently )?(?:reside|live) in|are you (?:currently )?a resident of) (?:the )?(.+)\?$/.exec(
    q,
  )?.[1] ?? null;
const minimumDegreeRank = (q: string) => {
  const match =
    /^do you have (?:at least |a minimum of )an? (associate's|bachelor's|master's) degree(?: for your educational background)?\?$/.exec(
      q,
    );
  return match
    ? (
        { "associate's": 2, "bachelor's": 3, "master's": 4 } as Record<
          string,
          number
        >
      )[match[1]]
    : null;
};

function exact(
  field: Field,
  value: unknown,
  aliases: string[] = [],
): Suggestion | null {
  const v = text(value);
  if (!v) return null;
  if (field.kind !== "select") return { value: v };
  const choices = field.options.filter((o) =>
    [v, ...aliases].some((a) => lower(a) === lower(o)),
  );
  return choices.length === 1 ? { value: choices[0] } : null;
}

function schoolAnswer(context: RuleContext): Suggestion | null {
  const school =
    text(context.profile.school) ??
    confirmedEducation(context.profile.education)?.school;
  if (!school) return null;
  if (context.field.kind === "select" && !context.field.options.length)
    return { value: school, search: school };
  if (context.field.kind === "select") {
    const normalized = (s: string) => lower(s).replace(/\s+[-–—]\s+/g, " ");
    const choices = context.field.options.filter(
      (o) => normalized(o) === normalized(school),
    );
    return choices.length === 1 ? { value: choices[0] } : null;
  }
  return exact(context.field, school);
}

function educationAnswer(context: RuleContext): Suggestion | null {
  const education = primaryEducation(context.profile);
  if (!education) return null;
  const value =
    context.field.id === "degree--0" ? education.degree : education.discipline;
  if (!value) return null;
  const engineering =
    context.field.id === "discipline--0" && /\bengineering$/i.test(value);
  if (context.field.kind === "select" && !context.field.options.length) {
    const option = engineering ? "Engineering" : value;
    return {
      value: option,
      ...(context.field.id === "discipline--0" ? { search: option } : {}),
    };
  }
  return (
    exact(context.field, value) ??
    (engineering ? exact(context.field, "Engineering") : null)
  );
}

function experienceAnswer(context: RuleContext): Suggestion | null {
  const experience = context.profile.resumeFacts?.experience;
  if (!experience) return null;
  const choices = context.field.options.filter((option) => {
    const range = /^(\d+)\s*[–—-]\s*(\d+)(?:\s*years?)?$/i.exec(option);
    if (range)
      return (
        experience.minYears >= Number(range[1]) &&
        experience.maxYears <= Number(range[2])
      );
    const above = /^(\d+)\+(?:\s*years?)?$/i.exec(option);
    return above && experience.minYears >= Number(above[1]);
  });
  return choices.length === 1 ? { value: choices[0] } : null;
}

// Overall professional experience only; "with TypeScript" or "React
// experience" asks about one technology and stays unmatched.
const overallExperience = [
  // "How many years of professional experience do you have as a software engineer?"
  /^how many years of (?:(?:relevant|professional|total|paid|industry|work) )*(?:(?:software(?: engineering| development)?|engineering) )?experience(?: do you(?: have)?| have you(?: had)?)?(?: (?:as an?|in) (?:professional )?(?:software|full[- ]stack|web)?(?: ?(?:engineer|developer|engineering|development)))?\??$/,
  // "Years of professional experience"
  /^(?:total )?years of (?:professional |relevant )?experience\??$/,
];

function companyQuestion(q: string, company: string): string {
  let normalized = company ? q.replaceAll(lower(company), "{employer}") : q;
  normalized = normalized
    .replace(/\bunited states of america\b/g, "united states")
    .replace(/\bu\.s\.(?:a\.)?(?=\s|[?(),:]|$)/g, "united states");
  return normalized;
}

const basic: Record<string, [string[], (profile: Profile) => unknown]> = {
  first_name: [["first name"], (profile) => profile.firstName],
  last_name: [["last name"], (profile) => profile.lastName],
  email: [["email", "email address"], (profile) => profile.email],
  phone: [["phone", "phone number"], (profile) => profile.phone],
};

const autofillRules: Rule[] = [
  {
    name: "semantic contact",
    matcher: (c) =>
      c.field.semanticRole !== undefined &&
      [
        "first-name",
        "last-name",
        "full-name",
        "email",
        "phone",
        "city",
        "linkedin",
        "github",
        "website",
      ].includes(c.field.semanticRole),
    resolver: (c) => {
      const first = text(c.profile.firstName),
        last = text(c.profile.lastName);
      const values: Partial<Record<ApplicationSemanticRole, unknown>> = {
        "first-name": first,
        "last-name": last,
        "full-name": first && last ? `${first} ${last}` : null,
        email: c.profile.email,
        phone: c.profile.phone,
        city: c.city,
        linkedin: c.profile.linkedIn,
        github: c.profile.github,
        website: c.profile.website,
      };
      if (
        c.field.semanticRole === "city" &&
        ((c.field.kind === "select" && !c.field.options.length) ||
          /^(?:current )?location(?: \(city\))?\??$/.test(c.q))
      ) {
        return c.city && c.stateCode && c.profile.location?.country === "US"
          ? {
              value: `${c.city}, ${states[c.stateCode]}, United States`,
              search: c.city,
            }
          : null;
      }
      return exact(
        c.field,
        c.field.semanticRole && values[c.field.semanticRole],
      );
    },
  },
  {
    name: "basic contact",
    matcher: (c) =>
      basic[c.field.id]?.[0].includes(c.q) === true && c.field.kind === "text",
    resolver: (c) => exact(c.field, basic[c.field.id][1](c.profile)),
  },
  {
    name: "preferred name",
    matcher: (c) =>
      [
        "preferred first name",
        "preferred name",
        "what is your preferred first name, if different from your legal first name?",
      ].includes(c.q) && c.field.kind === "text",
    resolver: (c) => exact(c.field, c.profile.preferredFirstName),
  },
  {
    name: "primary school",
    matcher: (c) =>
      ["school", "school name", "university", "college/university"].includes(
        c.q,
      ) &&
      (!/^school--/.test(c.field.id) || c.field.id === "school--0"),
    resolver: schoolAnswer,
  },
  {
    name: "LinkedIn",
    matcher: (c) =>
      [
        "linkedin",
        "linkedin profile",
        "linkedin url",
        "linkedin profile url",
      ].includes(c.q),
    resolver: (c) => exact(c.field, c.profile.linkedIn),
  },
  {
    name: "GitHub",
    matcher: (c) =>
      [
        "github",
        "github url",
        "github profile",
        "github profile url",
        "github username / profile",
      ].includes(c.q),
    resolver: (c) => exact(c.field, c.profile.github),
  },
  {
    name: "website",
    matcher: (c) =>
      [
        "website",
        "personal website",
        "website url",
        "portfolio website",
        "github/website",
        "github / website",
      ].includes(c.q),
    resolver: (c) => exact(c.field, c.profile.website),
  },
  {
    name: "city",
    matcher: (c) =>
      [
        "what city do you live in?",
        "current city",
        "city of residence",
      ].includes(c.q) && c.field.kind === "text",
    resolver: (c) => exact(c.field, c.city),
  },
  {
    name: "US state",
    matcher: (c) =>
      [
        "what state do you live in?",
        "state",
        "state/province",
        "state of residence",
      ].includes(c.q) &&
      c.state !== null &&
      c.profile.location?.country === "US" &&
      c.stateCode !== null,
    resolver: (c) =>
      exact(c.field, c.stateCode, [
        states[c.stateCode!],
        `${c.stateCode} - ${states[c.stateCode!]}`,
        `${c.stateCode} – ${states[c.stateCode!]}`,
      ]),
  },
  {
    name: "primary degree or discipline",
    matcher: (c) =>
      (c.field.id === "degree--0" && c.q === "degree") ||
      (c.field.id === "discipline--0" && c.q === "discipline"),
    resolver: educationAnswer,
  },
  {
    name: "primary education dates",
    matcher: (c) => /^(start|end)-(month|year)--0$/.test(c.field.id),
    resolver: (c) => educationDateAnswer(c.field, c.profile),
  },
  {
    name: "highest completed education",
    matcher: (c) =>
      [
        "what is the highest level of education you have obtained?",
        "what is your highest level of completed education?",
        "highest level of completed education",
      ].includes(c.q),
    resolver: (c) =>
      exact(
        c.field,
        educationDegreeLabel(c.profile.resumeFacts?.highestDegreeRank),
      ),
  },
  {
    name: "experience range",
    matcher: (c) =>
      overallExperience.some((pattern) => pattern.test(c.q)) &&
      c.field.kind === "select" &&
      c.profile.resumeFacts?.experience !== undefined &&
      c.profile.resumeFacts?.experience !== null,
    resolver: experienceAnswer,
  },
  {
    name: "minimum degree",
    matcher: (c) => {
      const rank = minimumDegreeRank(c.q);
      return (
        rank !== null &&
        c.profile.resumeFacts?.highestDegreeRank !== undefined &&
        c.profile.resumeFacts.highestDegreeRank >= rank
      );
    },
    resolver: (c) => exact(c.field, "Yes"),
  },
  {
    name: "residency",
    matcher: (c) => {
      if (!c.residency) return false;
      if (
        [
          "united states",
          "united states of america",
          "u.s.",
          "us",
          "usa",
        ].includes(c.residency)
      )
        return typeof c.profile.location?.country === "string";
      return (
        requestedStateCode(c.residency) !== null &&
        c.stateCode !== null &&
        c.profile.location?.country === "US"
      );
    },
    resolver: (c) => {
      const country = c.profile.location?.country;
      if (
        [
          "united states",
          "united states of america",
          "u.s.",
          "us",
          "usa",
        ].includes(c.residency!)
      )
        return exact(c.field, yesNo(country === "US"));
      return exact(
        c.field,
        yesNo(requestedStateCode(c.residency) === c.stateCode),
      );
    },
  },
  {
    name: "listed-state residency",
    matcher: (c) =>
      c.residency !== null &&
      c.stateCode !== null &&
      c.profile.location?.country === "US" &&
      statesNamedInList(c.residency) !== null,
    resolver: (c) =>
      statesNamedInList(c.residency!)!.includes(c.stateCode!)
        ? exact(c.field, states[c.stateCode!], [c.stateCode!, "Yes"])
        : exact(c.field, "No"),
  },
  {
    name: "US country phone selector",
    matcher: (c) =>
      c.field.id === "country" &&
      c.q === "country" &&
      c.field.kind === "select" &&
      c.profile.location?.country === "US",
    resolver: () => ({ value: "United States +1" }),
  },
  {
    name: "candidate location",
    matcher: (c) =>
      c.field.id === "candidate-location" &&
      c.q === "location (city)" &&
      c.field.kind === "select" &&
      c.city !== null &&
      c.state !== null &&
      states[c.state.toUpperCase()] !== undefined &&
      c.profile.location?.country === "US",
    resolver: (c) => ({
      value: `${c.city}, ${states[c.state!.toUpperCase()]}, United States`,
      search: c.city!,
    }),
  },
  {
    name: "permanent work location",
    matcher: (c) =>
      c.q === "where is your permanent (city, state) work location?" &&
      c.city !== null &&
      c.state !== null &&
      c.field.kind === "text",
    resolver: (c) => exact(c.field, `${c.city}, ${c.state}`),
  },
  {
    name: "normalized company work authorization",
    matcher: (c) =>
      [
        "are you legally authorized to work in the united states?",
        "are you currently legally authorized to work in the united states?",
        "are you currently authorized to work in the united states?",
        "are you authorized to work in the united states?",
        "are you legally authorized to work in the united states for {employer}?",
        "are you legally authorized to work in the u.s.?",
      ].includes(c.companyQuestion),
    resolver: (c) => exact(c.field, yesNo(c.profile.authorizedToWorkUS)),
  },
  {
    name: "company sponsorship",
    matcher: (c) =>
      [
        "will you now or in the future require sponsorship for employment visa status?",
        "will you now or in the future require visa sponsorship?",
        "do you now or will you in the future require sponsorship for employment visa status?",
        "will you now or in the future require immigration sponsorship for employment visa status?",
        "will you now or in the future require employer sponsorship to obtain or maintain authorization to work in the united states?",
        "will you now or in the future require {employer} to sponsor or support an employment visa or work authorization in order to work in the united states?",
        "will you now or in the future require us to sponsor or support an employment visa or work authorization in order to work in the united states?",
        "will you now or in the future require the company to sponsor or support an employment visa or work authorization in order to work in the united states?",
        "do you now, or will you in the future, require sponsorship for employment to work legally for {employer} in the united states? (note: this includes visa statuses such as h-1b, and applies even if you don't need sponsorship immediately but will in the future, i.e. opt/cpt)",
      ].includes(c.companyQuestion),
    resolver: (c) => {
      const answer = yesNo(c.profile.requiresSponsorshipNowOrFuture);
      if (answer === null) return null;
      return exact(
        c.field,
        answer,
        c.company
          ? [
              answer === "No"
                ? `No, I do not require sponsorship now or in the future to work legally for ${c.company} in the United States.`
                : `Yes, I currently require sponsorship, or may require sponsorship in the future, to work legally for ${c.company} in the United States.`,
            ]
          : [],
      );
    },
  },
  {
    name: "job-country authorization",
    matcher: (c) =>
      c.q ===
        "are you currently authorized to work in the city/country where this position is located?" ||
      /^are you authorized to lawfully work for .+ in the country to which you are applying\?$/.test(
        c.q,
      ),
    resolver: (c) => exact(c.field, yesNo(c.profile.authorizedToWorkUS)),
  },
  {
    name: "job-country sponsorship",
    matcher: (c) =>
      /^do you now, or will you in the future, require employment visa sponsorship \(e\.g\., h-1b visa, renewals, etc\.\) to work lawfully for .+ in the country that you are applying to\?$/.test(
        c.q,
      ),
    resolver: (c) =>
      exact(c.field, yesNo(c.profile.requiresSponsorshipNowOrFuture)),
  },
  {
    name: "gender id",
    matcher: (c) => c.q === "gender" && c.field.id === "gender",
    resolver: (c) => exact(c.field, c.d.gender),
  },
  {
    name: "alternative gender wording",
    matcher: (c) =>
      [
        "how would you describe your gender identity? (mark all that apply)",
        "i identify my gender as:",
        "which of the following best describes your gender?",
      ].includes(c.q),
    resolver: (c) =>
      exact(c.field, c.d.gender, demographicAliases("gender", c.d.gender)),
  },
  {
    name: "race",
    matcher: (c) =>
      [
        "how would you describe your racial/ethnic background? (mark all that apply)",
        "which of the following best represents your racial or ethnic background: (check more than one if that is how you identify)",
        "which of the following best describes your racial or ethnic identity?",
      ].includes(c.q) ||
      (c.field.id === "race" &&
        ["race", "please identify your race"].includes(c.q) &&
        (!c.field.conditional || c.d.hispanicLatino === false)),
    resolver: (c) =>
      exact(
        c.field,
        c.d.race,
        demographicAliases("race", c.d.race, c.d.hispanicLatino),
      ),
  },
  {
    name: "Hispanic",
    matcher: (c) =>
      [
        "are you hispanic/latino?",
        "are you hispanic or latino?",
        "do you identify as hispanic or latino?",
      ].includes(c.q),
    resolver: (c) => exact(c.field, yesNo(c.d.hispanicLatino)),
  },
  {
    name: "protected veteran",
    // Protected-veteran status (VEVRAA) is narrower than having served, so a
    // saved "veteran: true" can't answer it; only a non-veteran is certainly
    // not a protected veteran. Veterans answer this legal declaration manually.
    matcher: (c) =>
      c.q === "veteran status" &&
      c.field.id === "veteran_status" &&
      c.d.veteran === false,
    resolver: (c) => exact(c.field, "I am not a protected veteran"),
  },
  {
    name: "veteran colon",
    matcher: (c) =>
      c.q === "veteran status:" && typeof c.d.veteran === "boolean",
    resolver: (c) =>
      exact(
        c.field,
        c.d.veteran ? "Yes, I am a veteran" : "No, I am not a veteran",
      ),
  },
  {
    name: "long disability question",
    matcher: (c) =>
      c.q ===
      "do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?",
    resolver: (c) => exact(c.field, yesNo(c.d.disability)),
  },
  {
    name: "visible disability",
    matcher: (c) =>
      c.q ===
      "do you identify as a person with a disability of any kind, visible or invisible?",
    resolver: (c) => exact(c.field, yesNo(c.d.disability)),
  },
  {
    name: "transgender",
    matcher: (c) =>
      [
        "do you identify as transgender?",
        "i identify as transgender:",
      ].includes(c.q),
    resolver: (c) => exact(c.field, yesNo(c.d.transgender)),
  },
  {
    name: "orientation",
    matcher: (c) =>
      [
        "how would you describe your sexual orientation? (mark all that apply)",
        "i identify my sexual orientation as:",
      ].includes(c.q),
    resolver: (c) => exact(c.field, c.d.sexualOrientation),
  },
  {
    name: "combined veteran and active military",
    matcher: (c) =>
      c.q ===
        "are you a veteran or active member of the united states armed forces?" &&
      (c.d.veteran === true ||
        c.d.activeMilitary === true ||
        (c.d.veteran === false && c.d.activeMilitary === false)),
    resolver: (c) =>
      exact(
        c.field,
        c.d.veteran === true || c.d.activeMilitary === true
          ? "Yes, I am a veteran or active member"
          : "No, I am not a veteran or active member",
      ),
  },
];

export function suggestAutofill(
  field: Field,
  profile: Profile,
  company: string,
): Suggestion | null {
  const q = lower(field.label);
  const d = profile.demographics ?? {};
  // A reference's name, email or phone must never fall through to the user's own.
  if (isProfessionalReferenceQuestion(field.label))
    return professionalReferenceAnswer(field, profile);
  const standing =
    employeeConnectionAnswer(field, profile) ?? residenceAnswer(field, profile);
  if (standing) return standing;
  const reusable = profileQuestionAnswer(field, profile);
  if (reusable) return reusable;
  const city = text(profile.location?.city);
  const state = text(profile.location?.state);
  const context: RuleContext = {
    field,
    q,
    profile,
    d,
    company,
    companyQuestion: companyQuestion(q, company),
    city,
    state,
    stateCode: stateCode(state),
    residency: residencyTarget(q),
  };
  const rule = autofillRules.find((candidate) => candidate.matcher(context));
  return rule ? rule.resolver(context) : null;
}
