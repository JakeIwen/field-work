export type ScanJob = {
  id: string;
  title: string;
  url: string;
  location: string;
  description: string;
  salary: string;
  remote?: boolean;
  listed?: boolean;
  deadline?: string | null;
  source: string;
  at: string;
  detailUrl?: string;
  detailVerified?: boolean;
  fingerprint?: string;
};
export type CompanyScan = {
  company_id: string;
  company: string;
  result: "SUCCESS" | "PARTIAL" | "FAILED";
  inventory_count: number | null;
  complete: boolean;
  sources: string[];
  notes: string;
  checked_at: string;
  jobs: ScanJob[];
  direct: Record<
    string,
    {
      status: "open" | "closed" | "unknown";
      reason: string;
      at: string;
      job?: ScanJob;
    }
  >;
};
