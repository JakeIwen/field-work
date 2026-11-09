import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeSyntheticRoot } from "./dev-options.js";

/** Preserve fictional source content without links to enabled third-party adapters. */
export function writeDemoSources(root: string) {
  writeSyntheticRoot(root);
  function sanitize(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) sanitize(file);
      else if (/\.(md|json|html)$/.test(entry.name)) {
        const original = readFileSync(file, "utf8");
        const scrubbed = original.replace(
          /https?:\/\/(?!example\.(?:com|org)(?:[/:]|$))[^\s/"<>]+/g,
          "https://example.org",
        );
        if (scrubbed !== original) writeFileSync(file, scrubbed);
      }
    }
  }
  sanitize(root);
}
