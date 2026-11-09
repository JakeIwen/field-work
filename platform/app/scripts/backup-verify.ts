import { readFileSync } from "node:fs";
import { verifyBackup } from "../server/backup-verify.js";

try {
  if (process.argv.length !== 3)
    throw new Error("Usage: npm run backup:verify -- <backup.zip>");
  const integrity = verifyBackup(readFileSync(process.argv[2]));
  console.log(JSON.stringify({ integrity }, null, 2));
  if (!integrity.ok) process.exitCode = 1;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
