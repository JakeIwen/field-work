import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { HostedApplicationProvider } from "../shared/application-host.js";

// Installed application assets are independent of the research checkout and CWD.
export const platformRoot = fileURLToPath(new URL("../../", import.meta.url));
export const repositoryRoot = path.resolve(
  process.env.JOB_SEARCH_ROOT ?? path.dirname(platformRoot),
);
// Preserve the existing durable store and registered thread working directories.
export const dataDirectory = path.resolve(
  process.env.JOB_SEARCH_DATA ?? path.join(repositoryRoot, ".local/job-search"),
);
export const sampleWorkspaceRoot = path.join(platformRoot, "sample-workspace");
export const platformDocs = path.join(platformRoot, "docs");
export const platformBuild = path.join(platformRoot, "dist");
export const pdfVerifier = fileURLToPath(
  new URL("../scripts/verify-pdf.swift", import.meta.url),
);

/** Releases carry their own helpers; source checkouts retain the automation paths. */
export function autofillHelperFile(
  provider: HostedApplicationProvider,
  assetsRoot = platformRoot,
): URL {
  const packagedRoot = path.join(assetsRoot, "automation");
  const helperRoot = existsSync(packagedRoot)
    ? packagedRoot
    : path.resolve(assetsRoot, "../automation");
  return pathToFileURL(path.join(helperRoot, provider, "console-helper.js"));
}
