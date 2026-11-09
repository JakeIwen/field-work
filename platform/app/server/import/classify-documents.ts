import path from "node:path";

import {
  currentResumePath as MASTER_PATH,
  sourceReadmePath as SOURCE_README,
} from "../../shared/workspace-sources.js";
export { MASTER_PATH, SOURCE_README };

type Rule<Context, Fields> = {
  predicate: (context: Context) => boolean;
  produce: (context: Context) => Fields;
};

type ClassificationInput = {
  relative: string;
  raw: string;
  currentVersion: string | null;
  currentTailoredDirectories?: readonly string[];
  privateDocumentPaths?: readonly string[];
};
type Scope = "general" | "tailored";
type Kind = "resume" | "cover-letter";
type Privacy = "public" | "private" | "unknown";
type Status = "rejected" | "current" | "superseded" | "draft";
type BaseContext = ClassificationInput & {
  base: string;
  parent: string;
  format: string;
};
type ScopeContext = BaseContext & { scope: Scope };
type CompanyContext = ScopeContext & { company: string | null };
type VersionContext = CompanyContext & { versionLabel: string };
type KindContext = VersionContext & { kind: Kind };
type CurrentContext = KindContext & {
  isCurrentGeneral: boolean;
  isCurrentTailored: boolean;
};

export type DocumentClassification = {
  base: string;
  parent: string;
  format: string;
  scope: Scope;
  company: string | null;
  versionLabel: string;
  versionNumber: number;
  kind: Kind;
  initialNotesPath: string;
  fallbackNotesPath: string;
  discardNotes: boolean;
  privacy: Privacy;
  isCurrentGeneral: boolean;
  isCurrentTailored: boolean;
  status: Status;
  bundleId: string;
  statusProvenance: string;
  privacyProvenance: string;
};

function firstMatch<Context, Fields>(
  rules: readonly Rule<Context, Fields>[],
  context: Context,
): Fields {
  for (const rule of rules) {
    if (rule.predicate(context)) return rule.produce(context);
  }
  throw new Error("Classification rule table has no fallback");
}

const importableRules: readonly Rule<{ relative: string }, boolean>[] = [
  {
    predicate: ({ relative }) => !/\.(html|pdf|md|txt|docx)$/i.test(relative),
    produce: () => false,
  },
  {
    predicate: ({ relative }) =>
      /(?:README|revision_notes|claim_audit|sync_notes)\.md$/i.test(relative),
    produce: () => false,
  },
  { predicate: () => true, produce: () => true },
];

const scopeRules: readonly Rule<BaseContext, Scope>[] = [
  {
    predicate: ({ relative }) => /^employer_specific\/[^/]+\/.+/.test(relative),
    produce: () => "tailored",
  },
  { predicate: () => true, produce: () => "general" },
];

const companyRules: readonly Rule<ScopeContext, string | null>[] = [
  {
    predicate: ({ scope }) => scope === "general",
    produce: () => null,
  },
  {
    predicate: () => true,
    produce: ({ relative }) =>
      relative
        .split("/")[1]
        .split(/[-_]+/)
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join(" "),
  },
];

const versionPattern = /(?:\/|_)(v\d+(?:_[a-z]+)?)(?=\/|_|\.)/i;
const versionRules: readonly Rule<CompanyContext, string>[] = [
  {
    predicate: ({ relative }) => /pre_v10_sync/.test(relative),
    produce: () => "pre-v10 sync",
  },
  {
    predicate: ({ relative }) => versionPattern.test(relative),
    produce: ({ relative }) => relative.match(versionPattern)?.[1] ?? "legacy",
  },
  {
    predicate: ({ relative }) => relative === MASTER_PATH,
    produce: ({ currentVersion }) => currentVersion ?? "unknown",
  },
  {
    predicate: ({ scope }) => scope === "tailored",
    produce: () => "legacy / unnumbered",
  },
  { predicate: () => true, produce: () => "legacy" },
];

const kindRules: readonly Rule<VersionContext, Kind>[] = [
  {
    predicate: ({ relative }) => /cover[_ -]?letter/i.test(relative),
    produce: () => "cover-letter",
  },
  { predicate: () => true, produce: () => "resume" },
];

const initialNotesRules: readonly Rule<KindContext, string>[] = [
  {
    predicate: ({ relative }) => relative.startsWith("source_master_template/"),
    produce: ({ parent, versionLabel }) =>
      `${parent}/${versionLabel === "v2_bad" ? "claim_audit" : "revision_notes"}.md`,
  },
  { predicate: () => true, produce: () => "" },
];

const fallbackNotesRules: readonly Rule<KindContext, string>[] = [
  {
    predicate: ({ scope }) => scope === "tailored",
    produce: ({ parent }) => `${parent}/README.md`,
  },
  { predicate: () => true, produce: () => "" },
];

const discardNotesRules: readonly Rule<KindContext, boolean>[] = [
  {
    predicate: ({ relative }) => /\/revisions\//.test(relative),
    produce: () => true,
  },
  { predicate: () => true, produce: () => false },
];

const privacyRules: readonly Rule<KindContext, Privacy>[] = [
  {
    predicate: ({ relative, privateDocumentPaths }) =>
      !!privateDocumentPaths?.includes(relative),
    produce: () => "private",
  },
  {
    predicate: ({ base }) => /(?:_public|_linkedin)(?:[_.]|$)/i.test(base),
    produce: () => "public",
  },
  {
    predicate: ({ raw }) =>
      /tel:|(?:\+?1[- .]?)?\(?\d{3}\)?[- .]\d{3}[- .]\d{4}/.test(raw),
    produce: () => "private",
  },
  { predicate: () => true, produce: () => "unknown" },
];

const currentGeneralRules: readonly Rule<KindContext, boolean>[] = [
  {
    predicate: ({ relative, currentVersion }) =>
      (relative.startsWith(`source_master_template/${currentVersion}/`) &&
        !!currentVersion) ||
      relative === MASTER_PATH,
    produce: () => true,
  },
  { predicate: () => true, produce: () => false },
];

const currentTailoredRules: readonly Rule<KindContext, boolean>[] = [
  {
    // As for the general master, the source README must name the current location.
    predicate: ({ parent, relative, currentTailoredDirectories }) =>
      !!currentTailoredDirectories?.includes(parent) &&
      /^employer_specific\/[^/]+\//.test(relative) &&
      !relative.includes("/revisions/"),
    produce: () => true,
  },
  { predicate: () => true, produce: () => false },
];

const statusRules: readonly Rule<CurrentContext, Status>[] = [
  {
    predicate: ({ relative }) => /v2_bad/.test(relative),
    produce: () => "rejected",
  },
  {
    predicate: ({ isCurrentGeneral, isCurrentTailored }) =>
      isCurrentGeneral || isCurrentTailored,
    produce: () => "current",
  },
  {
    predicate: ({ relative, scope }) =>
      scope === "general" || /\/revisions\//.test(relative),
    produce: () => "superseded",
  },
  { predicate: () => true, produce: () => "draft" },
];

const statusProvenanceRules: readonly Rule<CurrentContext, string>[] = [
  {
    predicate: ({ isCurrentGeneral }) => isCurrentGeneral,
    produce: () => SOURCE_README,
  },
  {
    predicate: ({ isCurrentTailored }) => isCurrentTailored,
    produce: ({ relative }) =>
      `employer_specific/${relative.split("/")[1]}/README.md`,
  },
  {
    predicate: ({ relative }) => /v2_bad/.test(relative),
    produce: () => "Explicit rejected directory name v2_bad",
  },
  {
    predicate: () => true,
    produce: () => "Legacy location; no application submission inferred",
  },
];

const versionNumberRules: readonly Rule<CurrentContext, number>[] = [
  {
    predicate: ({ versionLabel }) => /\d+/.test(versionLabel),
    produce: ({ versionLabel }) => Number(versionLabel.match(/\d+/)?.[0] ?? 0),
  },
  { predicate: () => true, produce: () => 0 },
];

const bundleRules: readonly Rule<CurrentContext, string>[] = [
  {
    predicate: ({ scope }) => scope === "general",
    produce: ({ versionLabel }) => `general:${versionLabel}`,
  },
  {
    predicate: () => true,
    produce: ({ company, parent, kind }) => `${company}:${parent}:${kind}`,
  },
];

const privacyProvenanceRules: readonly Rule<
  CurrentContext & { privacy: Privacy },
  string
>[] = [
  {
    predicate: ({ privacy }) => privacy === "public",
    produce: () => "Explicit public filename",
  },
  {
    predicate: ({ privacy }) => privacy === "private",
    produce: () =>
      "Phone present in source or explicitly identified by source README",
  },
  {
    predicate: () => true,
    produce: () => "No explicit privacy evidence",
  },
];

export function isImportableDocumentPath(relative: string): boolean {
  return firstMatch(importableRules, { relative });
}

export function classifyDocument(
  input: ClassificationInput,
): DocumentClassification {
  const base: BaseContext = {
    ...input,
    base: path.basename(input.relative),
    parent: path.posix.dirname(input.relative),
    format: path.extname(input.relative).slice(1).toLowerCase(),
  };
  const scoped: ScopeContext = {
    ...base,
    scope: firstMatch(scopeRules, base),
  };
  const company: CompanyContext = {
    ...scoped,
    company: firstMatch(companyRules, scoped),
  };
  const version: VersionContext = {
    ...company,
    versionLabel: firstMatch(versionRules, company),
  };
  const kind: KindContext = {
    ...version,
    kind: firstMatch(kindRules, version),
  };
  const current: CurrentContext = {
    ...kind,
    isCurrentGeneral: firstMatch(currentGeneralRules, kind),
    isCurrentTailored: firstMatch(currentTailoredRules, kind),
  };
  const privacy = firstMatch(privacyRules, kind);
  return {
    base: base.base,
    parent: base.parent,
    format: base.format,
    scope: scoped.scope,
    company: company.company,
    versionLabel: version.versionLabel,
    versionNumber: firstMatch(versionNumberRules, current),
    kind: kind.kind,
    initialNotesPath: firstMatch(initialNotesRules, kind),
    fallbackNotesPath: firstMatch(fallbackNotesRules, kind),
    discardNotes: firstMatch(discardNotesRules, kind),
    privacy,
    isCurrentGeneral: current.isCurrentGeneral,
    isCurrentTailored: current.isCurrentTailored,
    status: firstMatch(statusRules, current),
    bundleId: firstMatch(bundleRules, current),
    statusProvenance: firstMatch(statusProvenanceRules, current),
    privacyProvenance: firstMatch(privacyProvenanceRules, {
      ...current,
      privacy,
    }),
  };
}
