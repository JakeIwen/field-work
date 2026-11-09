import { tunables } from "./tunables-registry.js";
import {
  defaultGreenhouseEmploymentScope,
  type GreenhouseEmploymentType,
  type FocusedGreenhouseEmploymentType,
} from "./greenhouse-search.js";

export type GreenhouseGuidance = {
  // Only legacy captured runs use focused types; absence of scope preserves their policy.
  employmentTypes?: FocusedGreenhouseEmploymentType[];
  employmentScope?: GreenhouseEmploymentType[];
  instructions: string;
  searchTerms: string[];
};

export const greenhouseGuidanceLimits = {
  instructions: 4000,
  searchTerms: 8,
  searchTerm: 100,
};

export const emptyGreenhouseGuidance: GreenhouseGuidance = {
  employmentScope: [...defaultGreenhouseEmploymentScope],
  instructions: "",
  searchTerms: [],
};

export const validGreenhouseSearchTerm = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= greenhouseGuidanceLimits.searchTerm &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** One instruction text offered again from the Pull instructions history. */
export type GreenhouseGuidanceHistoryEntry = {
  id: string;
  instructions: string;
  // First saved or captured by a pull.
  createdAt: string;
  // Last saved or captured by a pull.
  lastUsedAt: string;
};
export const greenhouseGuidanceHistoryLimit =
  tunables["greenhouse.guidanceHistoryEntries"].default;

/** Built-in suggestions for common software-development search terms. */
export const greenhouseSuggestedSearchTerms = [
  "react",
  "typescript",
  "node.js",
  "javascript",
  "web developer",
  "integrations engineer",
  "api engineer",
  "react native",
  "angular",
  "graphql",
  "application engineer",
  "developer tools",
];
export const greenhouseSearchTermPoolLimit = 40;
// Custom terms the user added to the pool; the suggestions above are always offered.
export type GreenhouseSearchTermPoolSettings = {
  greenhouseSearchTermPool?: string[];
};

/** Body of POST /api/greenhouse/guidance: one version-checked settings write. */
export type GreenhouseGuidanceSave = {
  expectedVersion: number;
  guidance: Pick<GreenhouseGuidance, "instructions" | "searchTerms"> & {
    employmentScope: GreenhouseEmploymentType[];
  };
  excludedCompanies?: string[];
  searchTermPool?: string[];
  policy?: import("./greenhouse-policy.js").GreenhousePullPolicy;
};
