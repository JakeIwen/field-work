import type { Store } from "./storage.js";
import { now } from "./storage.js";
import type {
  ResumeVariantApplication,
  ResumeVariantReport,
  ResumeVariantRow,
} from "../shared/reports.js";

type DocRef = {
  id: string;
  hash: string;
  kind?: string;
  privacy?: string;
  name?: string;
  version?: string;
};

const kindOf = (kind: unknown): ResumeVariantRow["kind"] =>
  kind === "resume"
    ? "resume"
    : kind === "cover-letter"
      ? "cover-letter"
      : "other";

function describe(store: Store, ref: DocRef) {
  const generated = store.get("generated_document", ref.id);
  const cached = generated ? undefined : store.get("cache_document", ref.id);
  const doc: Partial<import("../shared/types.js").Document> =
    generated ?? cached ?? {};
  const kind = kindOf(doc.kind ?? ref.kind);
  const noun =
    kind === "resume"
      ? "resume"
      : kind === "cover-letter"
        ? "cover letter"
        : "document";
  const privacy = String(doc.privacy ?? ref.privacy ?? "unknown");
  const version = String(doc.version ?? ref.version ?? "");
  const source: ResumeVariantRow["source"] = generated
    ? "generated"
    : cached?.scope === "general" && Number(cached.versionNumber) > 0
      ? "general-master"
      : "legacy";
  const label =
    source === "generated"
      ? `Tailored ${noun} · ${doc.company || doc.postingLabel || "unknown posting"}`
      : source === "general-master"
        ? `${noun[0].toUpperCase()}${noun.slice(1)} ${version} (${privacy})`
        : String(doc.name ?? ref.name ?? ref.id);
  return {
    kind,
    privacy,
    source,
    label,
    generatedAt: (doc.createdAt ?? doc.authoredDate ?? null) as string | null,
  };
}

// Groups application packages by the exact document content (hash) that was
// sent, so each tailored or master variant shows the applications that used it
// and where those applications stand now.
export function resumeVariantReport(store: Store): ResumeVariantReport {
  const rows = new Map<
    string,
    ResumeVariantRow & { byApplication: Map<string, ResumeVariantApplication> }
  >();
  let applicationsWithoutPackage = 0;
  const resolve = (id: string): DocRef | undefined => {
    const doc = store.document(id);
    return doc
      ? {
          id: doc.id,
          hash: doc.hash,
          kind: doc.kind,
          privacy: doc.privacy,
          name: doc.name,
          version: doc.version,
        }
      : undefined;
  };
  for (const a of store.list("application")) {
    const opening = a.openingId ? store.opening(a.openingId) : undefined;
    const used: { ref: DocRef; sentAt: string | null }[] = [];
    for (const p of a.packages ?? []) {
      let documents: DocRef[] = (p.documents ?? []).filter((d: any) => d?.hash);
      if (!documents.length && p.source === "autofill-copy" && p.scriptId) {
        // Autofill-copy packages record the attachments through the saved script.
        const script = store.get("application_autofill", p.scriptId);
        const ids: string[] =
          script?.documentIds ??
          (script?.attachments ?? []).map((x: any) => x.documentId);
        documents = ids.map(resolve).filter((d): d is DocRef => !!d);
      }
      for (const ref of documents) used.push({ ref, sentAt: p.at ?? null });
    }
    const sent = used.length > 0;
    if (!sent) {
      applicationsWithoutPackage++;
      if (!a.submittedAt)
        for (const id of a.documentIds ?? []) {
          const ref = resolve(id);
          if (ref) used.push({ ref, sentAt: null });
        }
    }
    const stage =
      sent || a.submittedAt
        ? String(a.status ?? "unknown")
        : `${a.status ?? "unknown"} (not submitted)`;
    for (const { ref, sentAt } of used) {
      let row = rows.get(ref.hash);
      if (!row) {
        const info = describe(store, ref);
        row = {
          documentId: ref.id,
          hash: ref.hash,
          label: info.label,
          kind: info.kind,
          privacy: info.privacy,
          generatedAt: info.generatedAt,
          source: info.source,
          applications: [],
          stageCounts: {},
          byApplication: new Map(),
        };
        rows.set(ref.hash, row);
      }
      const prior = row.byApplication.get(a.id);
      if (prior) {
        if (sentAt && (!prior.packageSentAt || sentAt > prior.packageSentAt))
          prior.packageSentAt = sentAt;
        continue;
      }
      row.byApplication.set(a.id, {
        applicationId: a.id,
        openingId: a.openingId ?? null,
        company: String(opening?.company ?? a.company ?? "Unknown company"),
        title: String(opening?.title ?? a.title ?? "Unknown role"),
        stage,
        submittedAt: a.submittedAt ?? null,
        packageSentAt: sentAt,
      });
    }
  }
  const result = [...rows.values()].map(({ byApplication, ...row }) => {
    const applications = [...byApplication.values()];
    const stageCounts: Record<string, number> = {};
    for (const x of applications)
      stageCounts[x.stage] = (stageCounts[x.stage] ?? 0) + 1;
    return { ...row, applications, stageCounts };
  });
  result.sort(
    (x, y) =>
      y.applications.length - x.applications.length ||
      (y.generatedAt ?? "").localeCompare(x.generatedAt ?? "") ||
      x.label.localeCompare(y.label),
  );
  return { generatedAt: now(), rows: result, applicationsWithoutPackage };
}
