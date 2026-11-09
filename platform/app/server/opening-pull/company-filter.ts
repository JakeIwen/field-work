import {
  greenhouseCompanyFilterLimits,
  greenhouseCompanyKey,
} from "../../shared/greenhouse-company-filter.js";
import { HttpError } from "../storage.js";

export function validateExcludedGreenhouseCompanies(value: unknown): string[] {
  const { count, length } = greenhouseCompanyFilterLimits;
  if (
    !Array.isArray(value) ||
    value.length > count ||
    value.some((entry) => typeof entry !== "string")
  )
    throw new HttpError(
      400,
      `Use a list of up to ${count} excluded companies.`,
    );
  const names = (value as string[])
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    names.some(
      (name) =>
        name.length > length ||
        /[\r\n]/.test(name) ||
        !greenhouseCompanyKey(name),
    )
  )
    throw new HttpError(
      400,
      `Each company must be a single name or board token of up to ${length} characters.`,
    );
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()];
}
