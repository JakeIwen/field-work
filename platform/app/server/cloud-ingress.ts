import { readFileSync, lstatSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { isMachineToken } from "../shared/cloud-connection.js";
import {
  createCloudAccessMiddleware,
  type CloudAccessConfig,
} from "./cloud-access.js";

export function readMachineToken(file: string | undefined) {
  if (!file)
    throw new Error("FIELDWORK_MACHINE_TOKEN_FILE is required in cloud mode");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "The machine token must be a private regular file (mode 600)",
    );
  const token = readFileSync(file, "utf8").trim();
  if (!isMachineToken(token)) throw new Error("Invalid machine token");
  return token;
}

/** The local companion authenticates separately from browser Access sessions. */
export function createCloudIngress(
  config: CloudAccessConfig,
  machineToken: string,
): RequestHandler {
  if (!isMachineToken(machineToken)) throw new Error("Invalid machine token");
  const access = createCloudAccessMiddleware(config);
  return (req, res, next) => {
    const supplied = req.headers["x-fieldwork-machine-token"];
    if (supplied !== undefined) {
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      );
      if (
        !loopback ||
        !isMachineToken(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(machineToken))
      ) {
        res
          .status(401)
          .json({ error: "Local connection authentication required" });
        return;
      }
      next();
      return;
    }
    return access(req, res, next);
  };
}
