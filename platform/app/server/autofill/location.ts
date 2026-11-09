import { usStates } from "../../shared/us-states.js";
import { isUSOnlyPosting } from "./profile-answers.js";
import { countrySkipNote } from "../work-permission.js";

// These are job-specific location labels, never company headquarters, salary
// currencies, or incidental country mentions in the description.
function country(label: string): string | null {
  if (isUSOnlyPosting(label)) return "US";
  const value = label
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (/^(?:remote )?canada(?: remote)?$/.test(value)) return "CA";
  if (/^(?:remote )?(?:united kingdom|uk|u k)(?: remote)?$/.test(value))
    return "GB";
  return null;
}

// Interpret city/state labels only with corroborating job-specific US office data.
function usCityList(label: string) {
  const cities = label
    .replace(/^(?:remote|hybrid|on-site)\s*[-–—:]\s*/i, "")
    .split(/\s+[-–—]\s+|\s*[;|]\s*/);
  return cities.every((city) => {
    const match = /^[A-Za-z][A-Za-z .'-]+,\s*([A-Z]{2})$/.exec(city.trim());
    return !!match && Object.hasOwn(usStates, match[1]);
  });
}

export function autofillLocation(api: any, profile: any) {
  const location =
    typeof api.location?.name === "string" ? api.location.name : "";
  const offices: { name: string; location: string }[] = (
    Array.isArray(api.offices) ? api.offices : []
  ).map((office: any) => ({
    name: typeof office.name === "string" ? office.name : "",
    location: typeof office.location === "string" ? office.location : "",
  }));
  const labels = [
    location,
    ...offices.flatMap((office) => [office.name, office.location]),
  ].filter(Boolean);
  const company =
    typeof api.company_name === "string" ? api.company_name.trim() : "";
  const labelCountry = (label: string) => {
    const direct = country(label);
    if (direct) return direct;
    if (
      usCityList(label) &&
      offices.some(
        (office) =>
          country(office.name) === "US" || country(office.location) === "US",
      )
    )
      return "US";
    if (!company) return null;
    // Job office names can include the exact employer followed by a country.
    // Strip only that known prefix, retaining unknown or conflicting locations.
    for (const separator of [" - ", " – ", " — ", ": "]) {
      const prefix = company + separator;
      if (label.toLowerCase().startsWith(prefix.toLowerCase()))
        return country(label.slice(prefix.length));
    }
    return null;
  };
  const countries = [
    ...new Set(labels.map(labelCountry).filter((c): c is string => !!c)),
  ];
  const unresolvedLabels = labels.filter(
    (label) =>
      !labelCountry(label) && !/^(?:remote|any location)$/i.test(label.trim()),
  );
  // A location explicitly naming a country and contrary office metadata must
  // remain unresolved. Generic Remote can instead inherit job-specific offices.
  const named = labelCountry(location);
  const conflicting = !!named && countries.some((c) => c !== named);
  const remote = /\bremote\b/i.test(location);
  const preference = profile.applicationLocation;
  const confirmedUSRemote =
    preference?.country === "US" &&
    preference?.remoteRolesWithoutRelocationAssistance === true &&
    remote;
  const applicationCountry =
    !conflicting && !unresolvedLabels.length
      ? countries.length === 1
        ? countries[0]
        : confirmedUSRemote && countries.includes("US")
          ? "US"
          : null
      : null;
  return {
    location,
    offices,
    countries,
    unresolvedLabels,
    conflicting,
    applicationCountry,
    remote,
    preferredCountry:
      typeof preference?.country === "string" ? preference.country : null,
    countryMismatch:
      !!preference?.country &&
      !!applicationCountry &&
      preference.country !== applicationCountry,
  };
}

/** Explicit employer skip instructions can omit an optional field without
 * making any declaration about the applicant's foreign work authorization. */
export function skipForPostingCountry(
  label: string,
  postingCountry: string | null | undefined,
) {
  const condition = countrySkipNote.exec(label)?.[1];
  if (!condition || !postingCountry) return false;
  const countries = condition
    .replace(/\bthe\s+/gi, "")
    .split(/\s+or\s+|,\s*/)
    .map(country);
  return countries.every(Boolean) && countries.includes(postingCountry);
}
