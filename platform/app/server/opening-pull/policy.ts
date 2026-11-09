import {
  greenhousePolicyVersion,
  greenhousePullPolicy,
  type CapturedGreenhousePolicy,
} from "../../shared/greenhouse-policy.js";
import {
  defaultFitCriteria,
  normalizeFitCriteria,
} from "../../shared/fit-criteria.js";
import type { Settings } from "../records.js";
import type { PullRun } from "../greenhouse-pull-records.js";

/** New pulls freeze selection inputs; changing defaults cannot alter a running pull. */
export function captureGreenhousePolicy(
  settings: Settings,
  capturedAt: string,
): CapturedGreenhousePolicy {
  const criteria = normalizeFitCriteria(settings.fitCriteria);
  return {
    ...greenhousePullPolicy(settings),
    policyVersion: greenhousePolicyVersion,
    capturedAt,
    titleExcludeTerms: [...criteria.titleExcludeTerms],
    technologyExcludeTerms: [...criteria.technologyExcludeTerms],
    excludedCompanies: [...(settings.greenhouseExcludedCompanies ?? [])],
  };
}

/** Old runs never captured these inputs. Keep their fixed defaults/live lists,
 * not today's saved policy, and do not invent a historical capture time. */
export function legacyGreenhousePolicy(
  settings: Settings,
): CapturedGreenhousePolicy {
  return {
    ...captureGreenhousePolicy(
      { ...settings, greenhousePolicy: undefined },
      "",
    ),
    legacy: true,
  };
}

export function runGreenhousePolicy(
  run: Pick<PullRun, "policy" | "guidance"> | undefined,
  settings: Settings,
): CapturedGreenhousePolicy {
  return run?.policy ?? legacyGreenhousePolicy(settings);
}

export function greenhousePolicyFitCriteria(policy: CapturedGreenhousePolicy) {
  return {
    ...defaultFitCriteria,
    titleExcludeTerms: policy.titleExcludeTerms,
    technologyExcludeTerms: policy.technologyExcludeTerms,
  };
}
