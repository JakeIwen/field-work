import {
  defaultFitCriteria,
  normalizeFitCriteria,
  type FitCriteria,
} from "../shared/fit-criteria.js";

// Compiles the editable fit criteria (settings.fitCriteria) into the matchers
// used by careers-scan candidate(). Terms are case-insensitive whole words that
// also match a simple plural; a space or hyphen in a term matches " ", "-" or
// nothing, and "." is optional (so "Node.js" also matches "NodeJS").
export type CompiledFitCriteria = {
  seniority: RegExp | null;
  titleRequire: RegExp | null;
  titleExclude: RegExp | null;
  roleExclude: RegExp | null;
  locationExclude: RegExp | null;
  locationSentence: RegExp | null;
  usLocation: RegExp | null;
  bareLocation: RegExp;
  bodyRequire: RegExp | null;
  remoteLocation: RegExp | null;
  remoteBody: RegExp | null;
};

const before = "(?<![\\p{L}\\p{N}_])",
  after = "(?![\\p{L}\\p{N}_])";
export function termPattern(term: string) {
  if (term.trim().toLowerCase() === ".net")
    return "(?:asp\\.net|\\.net|dot[ -]?net)(?=$|[^\\p{L}_])";
  if (term.trim().toLowerCase() === "c#")
    return "(?:c#|c[ -]?sharp)(?=$|[^\\p{L}_])";
  const body = term
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split(".")
        .map((piece) => piece.replace(/[\\^$*+?()[\]{}|/]/g, "\\$&"))
        .join("\\.?"),
    )
    .join("[ -]?");
  return /\p{L}$/u.test(term.trim()) ? `${body}s?` : body;
}

export function excludedTechnology(
  text: string,
  input: FitCriteria,
): string | undefined {
  const c = normalizeFitCriteria(input);
  return c.technologyExcludeTerms.find((term) => {
    const special = [".net", "c#"].includes(term.toLowerCase());
    return new RegExp(
      `${before}(?:${termPattern(term)})${special ? "" : after}`,
      "iu",
    ).test(text);
  });
}
const alternation = (terms: string[]) =>
  terms.map(termPattern).filter(Boolean).join("|");
function anyTerm(terms: string[]) {
  const alt = alternation(terms);
  return alt ? new RegExp(`${before}(?:${alt})${after}`, "iu") : null;
}
// Timezone labels are an always-on bare-location rule, as in the original filter.
const timezones = ["PST", "EST", "CST", "MST", "PDT", "EDT"];

const cache = new WeakMap<FitCriteria, CompiledFitCriteria>();
export function compileFitCriteria(
  input: FitCriteria = defaultFitCriteria,
): CompiledFitCriteria {
  const cached = cache.get(input);
  if (cached) return cached;
  const c = input === defaultFitCriteria ? input : normalizeFitCriteria(input);
  const locationAlt = alternation(c.locationExcludeTerms);
  const compiled: CompiledFitCriteria = {
    seniority: anyTerm(c.seniorityTerms),
    titleRequire: anyTerm(c.titleRequireTerms),
    titleExclude: anyTerm(c.titleExcludeTerms),
    roleExclude: anyTerm(c.roleExcludeTerms),
    locationExclude: anyTerm(c.locationExcludeTerms),
    locationSentence: locationAlt
      ? new RegExp(
          `this (?:role|position) (?:is|requires)[^.\\n]{0,40}${before}(?:${locationAlt})${after}`,
          "iu",
        )
      : null,
    usLocation: anyTerm(c.usLocationTerms),
    // A location that is only a remote indicator or US timezone ("Remote",
    // "Distributed", "US remote", "EST") counts as US-compatible.
    bareLocation: new RegExp(
      `^\\s*(?:${alternation([...c.remoteTerms, ...timezones])})\\s*$`,
      "iu",
    ),
    bodyRequire: anyTerm(c.bodyRequireTerms),
    // Single-word remote indicators are read from the location only; multi-word
    // phrases such as "fully remote" are also read from the description.
    remoteLocation: anyTerm(c.remoteTerms),
    remoteBody: anyTerm(c.remoteTerms.filter((t) => /[\s-]/.test(t.trim()))),
  };
  cache.set(input, compiled);
  return compiled;
}
