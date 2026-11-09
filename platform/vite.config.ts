import { execFileSync } from "node:child_process";
import path from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:client` (app/scripts/dev-client.ts) serves the working-tree
// client with hot reload and sends /api and /internal to a local backend: by
// default the launchd companion on 4317 (live cloud data), or a dev:server
// sandbox when --api names its port. The wrapper passes the port in this env
// var; a plain `vite build` ignores the server block.
const apiPort = Number(process.env.FIELDWORK_DEV_API ?? 4317);
const apiOrigin = `http://127.0.0.1:${apiPort}`;

// The badge shows which checkout a preview port belongs to, so parallel
// sessions in worktrees can be told apart.
function currentBranch() {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch) return branch;
  } catch {
    // Not a git checkout, or a detached HEAD: fall through to the folder name.
  }
  return path.basename(path.resolve(process.cwd(), ".."));
}

const proxied: ProxyOptions = {
  target: apiOrigin,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq, req) => {
      // The backend accepts only its own origin. Translate requests from this
      // dev server's page; any other origin passes through unchanged so the
      // backend still rejects it.
      if (req.headers.origin === `http://${req.headers.host}`)
        proxyReq.setHeader("origin", apiOrigin);
    });
    proxy.on("proxyRes", (proxyRes) => {
      // /api/events is a server-sent-events stream; tell any intermediary not
      // to hold its chunks back.
      if (String(proxyRes.headers["content-type"]).includes("event-stream"))
        proxyRes.headers["x-accel-buffering"] = "no";
    });
  },
};

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  define: {
    __DEV_BRANCH__: JSON.stringify(currentBranch()),
    __DEV_API_PORT__: JSON.stringify(String(apiPort)),
  },
  // Port is Vite's default start; with strictPort off it takes the next free
  // one, so parallel sessions never collide.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: { "/api": proxied, "/internal": proxied },
  },
});
