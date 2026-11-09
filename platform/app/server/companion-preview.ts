import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import { clientSecurityHeaders } from "./client-security.js";

export const previewDirectory = (dataDir: string) =>
  path.join(dataDir, "preview-client");

export function currentPreview(directory: string) {
  const release: unknown = JSON.parse(
    readFileSync(path.join(directory, "current.json"), "utf8"),
  );
  if (typeof release !== "string" || !/^[a-f0-9-]{36}$/.test(release))
    throw new Error("Invalid local preview release");
  return path.join(directory, "releases", release);
}

function regularFile(root: string, relative: string) {
  try {
    const file = path.join(root, relative);
    const resolved = realpathSync(file);
    if (
      !resolved.startsWith(realpathSync(root) + path.sep) ||
      !lstatSync(resolved).isFile()
    )
      return null;
    return resolved;
  } catch {
    return null;
  }
}

/** APIs/capabilities never enter the SPA fallback or a local file lookup. */
export function companionPreview(dataDir: string): RequestHandler {
  const directory = previewDirectory(dataDir);
  return (req, res, next) => {
    if (/^\/(api|internal)(\/|$)/i.test(req.path)) return next();
    clientSecurityHeaders(res);
    if (!["GET", "HEAD"].includes(req.method)) return res.status(405).end();
    let relative: string;
    try {
      relative = decodeURIComponent(req.path).slice(1);
    } catch {
      return res.status(400).end();
    }
    if (/^(api|internal)(\/|$)/i.test(relative)) return res.status(400).end();
    if (
      /%2f/i.test(req.path) ||
      relative.startsWith("/") ||
      relative.includes("\\") ||
      /[\x00-\x1f]/.test(relative) ||
      relative.split("/").some((part) => part.startsWith("."))
    )
      return res.status(400).end();
    let root: string;
    try {
      root = currentPreview(directory);
      if (!regularFile(root, "index.html")) throw new Error("Missing index");
    } catch {
      return res
        .status(503)
        .type("text")
        .send(
          "Local preview is not built. Run npm --prefix platform run deploy:preview.",
        );
    }
    const asset = relative.startsWith("assets/");
    const file = regularFile(
      asset ? path.join(directory, "assets") : root,
      asset ? relative.slice("assets/".length) : relative,
    );
    if (file) return res.sendFile(file, { dotfiles: "allow" });
    // Missing hashed chunks must fail, never return HTML or production assets.
    if (asset || path.extname(relative)) return res.status(404).end();
    return res.sendFile(path.join(root, "index.html"), { dotfiles: "allow" });
  };
}
