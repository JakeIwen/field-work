import { words } from "./profile-answers.js";

type ReferenceField = {
  label: string;
  kind: "text" | "textarea" | "select";
  options: string[];
};
type ReferenceDetail =
  "name" | "title" | "company" | "email" | "phone" | "relationship";
type SavedReference = Partial<Record<ReferenceDetail, unknown>>;

const ordinals: Record<string, number> = { first: 1, second: 2, third: 3 };
const counts: Record<string, number> = { two: 2, three: 3, four: 4 };

/** Questions about the user's professional references, as opposed to employee
 * referrals or requisition/reference numbers. */
export function isProfessionalReferenceQuestion(label: string): boolean {
  const q = words(label);
  return (
    /\breferences?\b/.test(q) &&
    !/\breferences? (?:number|no|code|id)\b|\b(?:job|requisition|posting) reference\b|\bfor (?:your )?reference\b/.test(
      q,
    )
  );
}

/** "May we contact your references?" and equivalents. Background, credit or
 * employment checks bundled into the question are separate declarations. */
export function isReferenceContactPermission(label: string): boolean {
  const q = words(label);
  return (
    isProfessionalReferenceQuestion(label) &&
    /\b(?:contact(?:ing)?|reach(?:ing)? out to|call(?:ing)?|speak(?:ing)? (?:with|to)) (?:any of )?(?:your |any |the |these |my )?(?:listed |provided |professional )?references?\b|\b(?:conduct|perform|run|complete) (?:a )?reference checks?\b|\bcheck (?:your |my )?references\b/.test(
      q,
    ) &&
    !/\b(?:background|criminal|credit|drug|education|employment verification|verify (?:your |my )?employment)\b/.test(
      q,
    )
  );
}

const savedReferences = (profile: any): SavedReference[] =>
  Array.isArray(profile?.references)
    ? profile.references.filter(
        (r: unknown) => r && typeof r === "object" && !Array.isArray(r),
      )
    : [];
const fact = (reference: SavedReference | undefined, key: ReferenceDetail) =>
  typeof reference?.[key] === "string" && reference[key].trim()
    ? (reference[key] as string).trim()
    : null;

function requestedDetails(q: string): ReferenceDetail[] {
  const withoutCompanyName = q.replace(
    /\b(?:company|organization|organisation|employer) name\b/g,
    (match) => match.replace(/name$/, "    "),
  );
  const patterns: [ReferenceDetail, RegExp][] = [
    ["email", /\be ?mail\b/],
    ["phone", /\b(?:phone|telephone|mobile|cell)\b/],
    ["relationship", /\b(?:relationship|relation|how do you know)\b/],
    ["company", /\b(?:company|organization|organisation|employer)\b/],
    ["title", /\b(?:title|position)\b/],
    ["name", /\bname\b/],
  ];
  // Answer in the order the label asks, e.g. "title and company".
  return patterns
    .map(
      ([detail, pattern]) =>
        [detail, withoutCompanyName.search(pattern)] as const,
    )
    .filter(([, index]) => index >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([detail]) => detail);
}

function referenceNumber(q: string): number | null {
  const numbered =
    /\breferences? (\d)\b/.exec(q) ??
    /\b(\d)(?:st|nd|rd|th)? (?:professional |work )?reference\b/.exec(q);
  if (numbered) return Number(numbered[1]);
  const ordinal =
    /\b(first|second|third) (?:professional |work )?reference\b/.exec(q);
  return ordinal ? ordinals[ordinal[1]] : null;
}

const formatPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : phone;
};

function contactBlock(reference: SavedReference, multiline: boolean) {
  const name = fact(reference, "name");
  if (!name) return null;
  const role = [fact(reference, "title"), fact(reference, "company")]
    .filter(Boolean)
    .join(", ");
  const email = fact(reference, "email");
  const phone = fact(reference, "phone");
  const relationship = fact(reference, "relationship");
  const lines = [
    name,
    role,
    email && `Email: ${email}`,
    phone && `Phone: ${formatPhone(phone)}`,
    relationship && `Relationship: ${relationship}`,
  ].filter(Boolean);
  return lines.join(multiline ? "\n" : "; ");
}

function yesAnswer(field: ReferenceField) {
  if (field.kind !== "select") return { value: "Yes" };
  const yes = field.options.filter((o) => /^yes\b/.test(words(o)));
  return yes.length === 1 ? { value: yes[0] } : null;
}

/** Answer reference questions only from the saved `references` list and
 * reference preferences. Returns null for anything those facts do not cover,
 * including other consent wording, narrative questions and requests for more
 * references than are saved. */
export function professionalReferenceAnswer(
  field: ReferenceField,
  profile: any,
): { value: string } | null {
  if (!isProfessionalReferenceQuestion(field.label)) return null;
  const q = words(field.label);
  const references = savedReferences(profile);
  const provides = profile?.preferences?.professionalReferences;
  if (isReferenceContactPermission(field.label))
    return /^(?:when|how|who|which|what)\b/.test(q) ||
      profile?.preferences?.contactReferences !== true ||
      !references.length
      ? null
      : yesAnswer(field);
  if (
    /\b(?:may|can|could) we\b|\bpermission\b|\bconsent\b|\bauthori[sz]e\b|\breference checks?\b/.test(
      q,
    )
  )
    return null;

  if (
    /^(?:are you (?:willing|able) to|can you|will you|would you be (?:willing|able) to|do you have) (?:provide |supply |furnish |share |submit )?(?:\w+ )?(?:professional |work )?references?\b/.test(
      q,
    )
  ) {
    return provides === true && references.length ? yesAnswer(field) : null;
  }
  if (provides !== true || field.kind === "select") return null;

  const details = requestedDetails(q);
  const number = referenceNumber(q);
  // One or two named details fill just those facts; a longer list or a bare
  // "References" field gets the whole contact block.
  if (details.length === 1 || details.length === 2) {
    const reference = references[(number ?? 1) - 1];
    const values = details.map((key) => fact(reference, key));
    if (values.some((v) => !v)) return null;
    if (values.length === 1) return { value: values[0]! };
    return {
      value: values
        .map((v, i) => (details[i] === "phone" ? formatPhone(v!) : v))
        .join(", "),
    };
  }
  if (/\b(?:what|how|why|describe|say|tell|would)\b/.test(q)) return null;
  const count =
    /\b(two|three|four|[2-4]) (?:professional |work )?references\b/.exec(q);
  const wanted = count ? (counts[count[1]] ?? Number(count[1])) : null;
  const selected =
    number !== null
      ? [references[number - 1]]
      : references.slice(0, wanted ?? 1);
  if (
    !selected.length ||
    selected.some((r) => !r) ||
    (wanted !== null && selected.length < wanted)
  )
    return null;
  const blocks = selected.map((r) =>
    contactBlock(r, field.kind === "textarea"),
  );
  if (blocks.some((b) => !b)) return null;
  return { value: blocks.join(field.kind === "textarea" ? "\n\n" : " | ") };
}
