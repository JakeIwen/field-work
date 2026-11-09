// GET /api/reports/resume-variants
export type ResumeVariantApplication = {
  applicationId: string;
  openingId: string | null;
  company: string;
  title: string;
  stage: string; // application stage at report time
  submittedAt: string | null;
  packageSentAt: string | null;
};
export type ResumeVariantRow = {
  documentId: string;
  label: string; // human name, e.g. "Resume v12 (private)" or "Tailored resume · Fabrikam"
  hash: string;
  kind: "resume" | "cover-letter" | "other";
  privacy: string;
  generatedAt: string | null;
  source: "general-master" | "generated" | "legacy";
  applications: ResumeVariantApplication[];
  stageCounts: Record<string, number>;
};
export type ResumeVariantReport = {
  generatedAt: string;
  rows: ResumeVariantRow[]; // sorted by applications.length desc, then generatedAt desc
  applicationsWithoutPackage: number; // applications that have no sent package documents
};
