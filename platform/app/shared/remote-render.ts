export const remoteRenderOperations = [
  "resume",
  "cover-letter",
  "verify-pdf",
] as const;

export type RemoteRenderOperation = (typeof remoteRenderOperations)[number];

export type RemoteRenderFile = {
  name: string;
  bytes: string;
  hash: string;
};

export type RemoteRenderRequest = {
  schemaVersion: 1;
  operation: RemoteRenderOperation;
  renderer: { path: string; hash: string };
  coverLetter?: boolean;
  files: RemoteRenderFile[];
};

export type RemoteRenderResponse = {
  schemaVersion: 1;
  stdout: string;
  stderr: string;
  outputs: RemoteRenderFile[];
};

export type RemoteRenderFailure = {
  error: string;
  stdout?: string;
  stderr?: string;
};
