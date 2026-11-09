import { createServer } from "vite";
import { platformRoot } from "../server/paths.js";
import { parseDevClientArgs } from "./dev-options.js";

// Per-session hot-reload preview. The config reads the env var, so the wrapper
// runs Vite in this process instead of spawning its CLI.
const { api } = parseDevClientArgs(process.argv.slice(2));
process.env.FIELDWORK_DEV_API = String(api);
const server = await createServer({ root: platformRoot });
await server.listen();
server.printUrls();
console.log(`API proxied to http://127.0.0.1:${api}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void server.close().then(() => process.exit(0)));
