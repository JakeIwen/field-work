export type OpeningFormQuestionCounts = {
  personal: { label: string; reason: string }[];
  narrative: number;
};

export type OpeningFormCheck = OpeningFormQuestionCounts & {
  openingId: string;
  checkedAt: string;
  openingHash: string;
  profileHash: string;
  status: "ok" | "unsupported" | "failed";
  error?: string;
};

export type OpeningFormCheckPass = {
  startedAt: string;
  queued: number;
  completed: number;
  running: boolean;
};

export const openingFormChecksPath = "/api/openings/form-checks";
