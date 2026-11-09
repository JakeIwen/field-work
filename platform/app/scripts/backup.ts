import { createBackupArchive } from "../server/backup-archive.js";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { Store, now } from "../server/storage.js";
import { repositoryRoot as root, dataDirectory } from "../server/paths.js";
const store = new Store(root, dataDirectory);
try {
  const target = path.resolve(
    process.argv[2] ??
      path.join(
        root,
        `.local/job-search-backup-${now().replaceAll(":", "-")}.zip`,
      ),
  );
  const { bytes, integrity } = createBackupArchive(store);
  writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ target, integrity }, null, 2));
  if (!integrity.ok) {
    console.error(
      "Partial backup saved. Review backup-integrity.json before restoring.",
    );
    process.exitCode = 1;
  }
} finally {
  store.close();
}
