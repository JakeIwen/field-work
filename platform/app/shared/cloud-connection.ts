export const companionInternalRoutes = Object.freeze({
  render: "/internal/render",
  browserLive: "/internal/browser-live",
  browserCleanMcp: "/internal/browser-clean/mcp",
});

export const workspaceModes = Object.freeze({
  local: "local",
  cloud: "cloud",
  companion: "companion",
} as const);
export type WorkspaceMode =
  (typeof workspaceModes)[keyof typeof workspaceModes];

export const isMachineToken = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
