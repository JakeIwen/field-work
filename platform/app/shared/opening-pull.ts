import type { HostedApplicationProvider } from "./application-host.js";

export type OpeningPullProvider = HostedApplicationProvider;
export const openingPullDateLabels: Record<OpeningPullProvider, string> = {
  greenhouse: "Original publication",
  ashby: "Last published",
  lever: "Created",
};
export type OpeningSourceDate = {
  kind: "original-publication" | "last-published" | "created";
  value: string | null;
  source: string;
  fetchedAt: string;
};
export type OpeningPullSource = {
  provider: OpeningPullProvider;
  board: string;
  postingId: string;
  region: "global";
  apiUrl: string;
  pullId: string;
  date: OpeningSourceDate;
};
