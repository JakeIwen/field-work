import type {
  OpeningPullProvider,
  OpeningSourceDate,
} from "../../shared/opening-pull.js";

// Provider absence is the persisted Greenhouse contract, not an unknown source.
export const legacyPullProvider = "greenhouse" satisfies OpeningPullProvider;
export const pullProvider = (record: {
  provider?: OpeningPullProvider;
}): OpeningPullProvider => record.provider ?? legacyPullProvider;

export type PullCard = {
  provider?: OpeningPullProvider;
  id: string;
  board: string;
  title: string;
  company: string;
  url: string;
  firstPublished: string | null;
};
export type PullPosting = {
  provider?: OpeningPullProvider;
  raw: Record<string, unknown>;
  title?: string;
  text: string;
  apiUrl: string;
  fetchedAt: string;
  aliases: string[];
  sourceDate?: OpeningSourceDate;
};
export const pullPostingTitle = (posting: PullPosting) =>
  posting.title ?? String(posting.raw.title ?? "");
