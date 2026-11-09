import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { platformRoot, repositoryRoot } from "../server/paths.js";
import {
  claimServerFile,
  freeLoopbackPort,
  parseDevServerArgs,
  releaseServerFile,
  sandboxEnv,
  sandboxLayout,
  writeSyntheticRoot,
} from "./dev-options.js";

// Disposable local backend on synthetic fixture data. It is the ordinary
// server in local mode: no companion.json in the data directory, no cloud
// access env, and both the source root and the data directory under
// .local/dev/<name>, never the real checkout or .local/job-search.
// The real checkout is used only to locate .local/dev.
const { name, port: requested } = parseDevServerArgs(process.argv.slice(2));
const layout = sandboxLayout(repositoryRoot, name);
const tsx = path.join(platformRoot, "node_modules/.bin/tsx");

mkdirSync(layout.home, { recursive: true });
const port = requested ?? (await freeLoopbackPort());
claimServerFile(layout.serverFile, process.pid, port);
writeSyntheticRoot(layout.rootDir);

let populated = false;
try {
  populated = readdirSync(layout.dataDir).length > 0;
} catch {
  // Not created yet.
}
if (!populated) {
  const made = spawnSync(
    tsx,
    ["app/scripts/browser-refactor-fixture.ts", layout.dataDir],
    {
      cwd: platformRoot,
      stdio: "inherit",
      env: sandboxEnv(process.env, layout, port),
    },
  );
  if (made.status !== 0) {
    releaseServerFile(layout.serverFile);
    throw new Error("Fixture creation failed");
  }
}

const child = spawn(tsx, ["app/server/index.ts"], {
  cwd: platformRoot,
  stdio: "inherit",
  env: sandboxEnv(process.env, layout, port),
});
console.log(
  `Dev server (local mode, fixture data) on http://127.0.0.1:${port}`,
);
console.log(`Sandbox: ${layout.home}`);
console.log(`Client: npm run dev:client -- --api ${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  releaseServerFile(layout.serverFile);
  process.exit(code ?? 0);
});
