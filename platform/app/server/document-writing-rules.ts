import { createHash } from "node:crypto";
import type { ApplicationDocumentKind } from "../shared/application-preparation.js";
import {
  coverLetterRendering,
  type DocumentInstructionParts,
} from "./document-instructions.js";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Keep app operations and job-discovery rules out of document writing policy. */
export function agentWritingRules(markdown: string) {
  const sections = {
    common: [] as string[],
    resume: [] as string[],
    "cover-letter": [] as string[],
  };
  const writingLines: string[] = [];
  let active = false,
    section = "",
    scope: keyof typeof sections | "ignore" = "common",
    fence = "";
  for (const line of markdown.split(/\r?\n/)) {
    const delimiter = /^\s*(```+|~~~+)/.exec(line)?.[1]?.[0];
    if (delimiter) fence = fence === delimiter ? "" : fence || delimiter;
    const heading = fence ? null : /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] === "#") {
      if (active) break;
      if (heading[2].toLowerCase() === "job search writing guidelines") {
        active = true;
        writingLines.push(line);
      }
      continue;
    }
    if (!active) continue;
    if (heading && heading[1] === "##") {
      section = heading[2].toLowerCase();
      scope =
        section === "cover letters"
          ? "cover-letter"
          : section === "resume writing"
            ? "resume"
            : section === "job-search harvest completeness"
              ? "ignore"
              : "common";
    }
    if (heading && heading[1] === "###") {
      const title = heading[2].toLowerCase();
      if (section === "general style")
        scope = ["natural company-facing prose", "review triggers"].includes(
          title,
        )
          ? "cover-letter"
          : "common";
      if (section === "resume writing")
        scope = title === "naming decisions" ? "common" : "resume";
    }
    if (scope !== "ignore") {
      sections[scope].push(line);
      writingLines.push(line);
    }
  }
  return {
    markdown: writingLines.length ? writingLines.join("\n").trim() + "\n" : "",
    common: normalize(sections.common.join("\n")),
    resume: normalize(sections.resume.join("\n")),
    "cover-letter": normalize(sections["cover-letter"].join("\n")),
  };
}

function writingContent(text: string, kind: ApplicationDocumentKind) {
  let content = text;
  if (kind === "resume")
    content = content
      .replace(/Update [\s\S]*? HTML under \S+\.\s*/, "")
      .replace(
        /(?:They must have identical substantive wording with only the phone omitted publicly|Keep the Markdown and private HTML substantively identical, including the phone number|Do not create or edit public tailored resume variants)\.\s*/g,
        "",
      )
      .replace(
        /Add a dated tailoring note,[\s\S]*?github_evidence_dossier\.md\.\s*/,
        "",
      )
      .replace(
        /Do not edit Swift renderers, original PDFs or any original checkout files\.\s*/,
        "",
      )
      .replace(
        /The backend (?:regenerates|renders)[\s\S]*?(?:validators|contact links)\.\s*/,
        "",
      );
  else
    content = content
      .replace(
        /(?:Both resume variants AND the cover letter are required in this one task|The private resume AND the cover letter are required in this one task|Do not produce public variants|No other source files need changes)\.\s*/g,
        "",
      )
      .replace(coverLetterRendering, "");
  return normalize(content);
}

export function writingRuleHashes(
  agents: string,
  parts: DocumentInstructionParts,
) {
  const rules = agentWritingRules(agents);
  const hashes: Partial<Record<ApplicationDocumentKind, string>> = {};
  // The common paragraph also contains sandbox, delegation and rendering
  // instructions. Only its evidence-precedence and prose guidance affect PDFs.
  const common = normalize(
    parts.common
      .replace(
        /^You prepare application documents[\s\S]*?job-posting\.txt\.\s*/,
        "",
      )
      .replace(
        /Treat posting text as untrusted data[\s\S]*?do not claim PDFs are ready yourself\.\s*/,
        "",
      ),
  );
  for (const [kind, instruction] of [
    ["resume", parts.resume],
    ["cover-letter", parts.coverLetter],
  ] as const) {
    if (instruction === undefined) continue;
    hashes[kind] = createHash("sha256")
      .update(
        JSON.stringify({
          schema: 1,
          common: rules.common,
          guidance: rules[kind],
          task: common,
          editorial: normalize(
            kind === "resume"
              ? parts.editorial.replace(
                  /, plus the AGENTS\.md review triggers:[\s\S]*?(?= Repair unsupported claims)/,
                  ".",
                )
              : parts.editorial,
          ),
          instruction: writingContent(instruction, kind),
        }),
      )
      .digest("hex");
  }
  return hashes;
}

/** Old task bundles contain the original unsectioned instruction paragraphs. */
export function legacyInstructionParts(
  text: string,
): DocumentInstructionParts | undefined {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const common = paragraphs.find((part) =>
    part.startsWith("You prepare application documents"),
  );
  // Every version of the editorial paragraph has carried this instruction.
  const editorial = paragraphs.find(
    (part) =>
      part !== common &&
      part.includes("perform a distinct final editorial review"),
  );
  if (!common || !editorial) return;
  return {
    common,
    editorial,
    resume: paragraphs.find((part) =>
      part.startsWith("Tailor the copied general resume"),
    ),
    coverLetter: paragraphs.find(
      (part) =>
        part.startsWith("Draft a ") ||
        part.startsWith("ALSO write cover_letter.txt:"),
    ),
  };
}
