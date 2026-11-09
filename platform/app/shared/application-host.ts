import { greenhousePosting } from "./greenhouse-autofill.js";
import type { PostingAts } from "./posting-url.js";

// Retired provider values remain part of saved evidence and script records.
export type HostedApplicationProvider = Extract<
  PostingAts,
  "greenhouse" | "ashby" | "lever"
>;
export const hostedApplicationProviderLabels: Record<
  HostedApplicationProvider,
  string
> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
};
export type ApplicationHostRegion = "global";

type HostedApplicationBase = {
  provider: HostedApplicationProvider;
  region: ApplicationHostRegion;
  host: string;
  board: string;
  postingId: string;
  url: string;
  applicationUrl: string;
};

export type GreenhouseHostedApplication = HostedApplicationBase & {
  provider: "greenhouse";
  jobId: string;
};
export type AshbyHostedApplication = HostedApplicationBase & {
  provider: "ashby";
};
export type LeverHostedApplication = HostedApplicationBase & {
  provider: "lever";
};
export type HostedApplicationIdentity =
  GreenhouseHostedApplication | AshbyHostedApplication | LeverHostedApplication;

export function hostedApplication(
  value: string,
): HostedApplicationIdentity | null {
  try {
    const raw = value.trim();
    const rawUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/.exec(raw);
    const url = new URL(raw);
    if (
      !rawUrl ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      /:\d+$/.test(rawUrl[1]) ||
      /%[0-9A-Fa-f]{2}/.test(rawUrl[2])
    )
      return null;
    const greenhouse = greenhousePosting(value);
    if (greenhouse)
      return {
        provider: "greenhouse",
        region: "global",
        host: new URL(greenhouse.applicationUrl).hostname,
        board: greenhouse.board,
        postingId: greenhouse.jobId,
        jobId: greenhouse.jobId,
        url: greenhouse.url,
        applicationUrl: greenhouse.applicationUrl,
      };
    return null;
  } catch {
    return null;
  }
}

export function sameHostedApplication(left: string, right: string): boolean {
  const a = hostedApplication(left);
  const b = hostedApplication(right);
  return Boolean(
    a &&
    b &&
    a.provider === b.provider &&
    a.region === b.region &&
    a.board === b.board &&
    a.postingId === b.postingId,
  );
}
