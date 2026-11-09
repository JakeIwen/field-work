import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { isMachineToken } from "../shared/cloud-connection.js";

export interface CompanionConfig {
  sshTarget: string;
  sshIdentityFile: string;
  cloudOrigin: string;
  cloudPort: 4317;
  localForwardPort: 44317;
  remoteForwardPort: 44318;
  machineToken: string;
}

const expectedKeys = [
  "cloudOrigin",
  "cloudPort",
  "localForwardPort",
  "machineToken",
  "remoteForwardPort",
  "sshIdentityFile",
  "sshTarget",
];

export function validateCompanionConfig(value: unknown): CompanionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Companion configuration must be an object");
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).sort().join("\0") !== expectedKeys.join("\0") ||
    config.cloudPort !== 4317 ||
    config.localForwardPort !== 44317 ||
    config.remoteForwardPort !== 44318
  )
    throw new Error("Companion configuration has an unexpected value");
  if (
    typeof config.sshTarget !== "string" ||
    !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
      config.sshTarget,
    )
  )
    throw new Error("Companion SSH target must be a host or user@host");
  if (typeof config.cloudOrigin !== "string")
    throw new Error("Companion cloud origin must be an HTTPS origin");
  const origin = new URL(config.cloudOrigin);
  if (
    origin.origin !== config.cloudOrigin ||
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Companion cloud origin must be an HTTPS origin");
  if (
    typeof config.sshIdentityFile !== "string" ||
    !path.isAbsolute(config.sshIdentityFile) ||
    /[\x00-\x1f]/.test(config.sshIdentityFile)
  )
    throw new Error("Companion SSH identity must be an absolute path");
  if (!isMachineToken(config.machineToken))
    throw new Error("Companion machine token is invalid");
  return config as unknown as CompanionConfig;
}

export function readCompanionConfig(file: string): CompanionConfig {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new Error("Companion configuration must be a regular mode 600 file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("Companion configuration must be owned by this user");
  return validateCompanionConfig(JSON.parse(readFileSync(file, "utf8")));
}
