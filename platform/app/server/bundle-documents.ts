import path from "node:path";
import { documentKind, type BundleArtifact } from "../shared/bundle-files.js";

export type BundleDocument = {
  kind: "resume" | "cover-letter";
  source: string;
  privateHtml: string;
  publicHtml?: string;
  privatePdf: string;
  publicPdf?: string;
};

// Only current files directly in the target directory are candidates. A
// historical copy must never fill a missing current variant. Never choose the
// first file by traversal order when the document identity is ambiguous.
export function bundleDocuments(
  artifacts: BundleArtifact[],
  versionDir: string,
  master: string,
  privateOnly = false,
) {
  const current = artifacts.filter(
    (a) => path.posix.dirname(a.path) === versionDir,
  );
  const errors: string[] = [];
  const documents: BundleDocument[] = [];
  const unknown = current.filter(
    (a) => /\.(html|pdf)$/i.test(a.path) && !documentKind(a.path),
  );
  if (unknown.length)
    errors.push(
      `Cannot determine document type: ${unknown.map((a) => a.path).join(", ")}. Use an unambiguous resume or cover-letter filename.`,
    );
  for (const kind of ["resume", "cover-letter"] as const) {
    const files = current.filter((a) => documentKind(a.path) === kind);
    if (kind === "cover-letter" && !files.length) continue;
    const startErrors = errors.length;
    const one = (format: string, privacy?: "private" | "public") => {
      const candidates = files.filter(
        (a) =>
          a.path.toLowerCase().endsWith("." + format) &&
          (!privacy ||
            /_public\.[^.]+$/i.test(a.path) === (privacy === "public")),
      );
      if (candidates.length !== 1) {
        errors.push(
          `Expected one ${privacy ? privacy + " " : ""}${kind} ${format.toUpperCase()} in ${versionDir}; found ${candidates.length}.`,
        );
        return "";
      }
      return candidates[0].path;
    };
    const source = kind === "resume" ? master : one("md");
    if (!artifacts.some((a) => a.path === source))
      errors.push(
        `Missing ${kind} Markdown source: ${source || versionDir + "/cover_letter.md"}.`,
      );
    const privateHtml = one("html", "private");
    const publicHtml = privateOnly ? undefined : one("html", "public");
    const privatePdf = one("pdf", "private");
    const publicPdf = privateOnly ? undefined : one("pdf", "public");
    if (startErrors === errors.length)
      documents.push({
        kind,
        source,
        privateHtml,
        publicHtml,
        privatePdf,
        publicPdf,
      });
  }
  return { documents, errors };
}
