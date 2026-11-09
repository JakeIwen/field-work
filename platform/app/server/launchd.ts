import path from "node:path";

export const serviceLabel = "local.fieldwork";
export type ServiceScope = "boot" | "login";
export type ServiceConfig = {
  label: string;
  scope: ServiceScope;
  uid: number;
  username: string;
  home: string;
  node: string;
  loader: string;
  platform: string;
  root: string;
  data: string;
  port: number;
};
export function serviceDomain(config: ServiceConfig) {
  return config.scope === "boot" ? "system" : `gui/${config.uid}`;
}
export function serviceDestination(config: ServiceConfig) {
  return path.join(
    config.scope === "boot"
      ? "/Library/LaunchDaemons"
      : path.join(config.home, "Library/LaunchAgents"),
    `${config.label}.plist`,
  );
}
export function validateServiceConfig(config: ServiceConfig) {
  if (
    config.label !== serviceLabel ||
    !["boot", "login"].includes(config.scope)
  )
    throw new Error("Invalid Fieldwork service identity");
  if (
    !Number.isSafeInteger(config.uid) ||
    config.uid <= 0 ||
    !/^[a-zA-Z0-9_-]+$/.test(config.username) ||
    config.username === "root"
  )
    throw new Error("Fieldwork must run as the owning non-root user");
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw new Error("Invalid service port");
  for (const key of [
    "home",
    "node",
    "loader",
    "platform",
    "root",
    "data",
  ] as const)
    if (!path.isAbsolute(config[key]) || /[\x00-\x1f]/.test(config[key]))
      throw new Error(`Invalid absolute ${key} path`);
}
export function serviceProperties(config: ServiceConfig) {
  validateServiceConfig(config);
  const properties: Record<string, unknown> = {
    Label: config.label,
    ProgramArguments: [
      config.node,
      "--import",
      config.loader,
      path.join(config.platform, "app/server/index.ts"),
    ],
    WorkingDirectory: config.platform,
    EnvironmentVariables: {
      // These describe the actual service owner, not a relocated credential store.
      HOME: config.home,
      USER: config.username,
      LOGNAME: config.username,
      PATH: [
        ...new Set([
          path.dirname(config.node),
          path.join(config.home, ".local/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ]),
      ].join(":"),
      PORT: String(config.port),
      JOB_SEARCH_ROOT: config.root,
      JOB_SEARCH_DATA: config.data,
      FIELDWORK_SERVICE_LABEL: config.label,
      FIELDWORK_SERVICE_SCOPE: config.scope,
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ExitTimeOut: 20,
    ProcessType: "Background",
    Umask: 63,
    StandardOutPath: path.join(config.data, "launchd.stdout.log"),
    StandardErrorPath: path.join(config.data, "launchd.stderr.log"),
  };
  if (config.scope === "boot") properties.UserName = config.username;
  return properties;
}
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
function xml(value: unknown): string {
  if (typeof value === "string") return `<string>${escape(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number" && Number.isInteger(value))
    return `<integer>${value}</integer>`;
  if (Array.isArray(value))
    return `<array>${value.map(xml).join("\n")}</array>`;
  if (value && typeof value === "object")
    return `<dict>${Object.entries(value)
      .map(([key, value]) => `<key>${escape(key)}</key>\n${xml(value)}`)
      .join("\n")}</dict>`;
  throw new Error("Unsupported plist value");
}
export function servicePlist(config: ServiceConfig) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${xml(serviceProperties(config))}\n</plist>\n`;
}
