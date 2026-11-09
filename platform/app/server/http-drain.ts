import type { Server, ServerResponse } from "node:http";

/**
 * Lets in-flight responses finish when the process stops. A response cut off
 * mid-body reaches Firefox as complete but truncated, so a restart during a
 * large `/api/state` download showed up as a JSON parse error. Event streams
 * never finish on their own and are ended at once.
 */
export function trackResponses(server: Server) {
  const active = new Set<ServerResponse>();
  let idle: (() => void) | undefined;
  server.on("request", (_req, res: ServerResponse) => {
    active.add(res);
    res.once("close", () => {
      active.delete(res);
      if (!active.size) idle?.();
    });
  });
  return async function drain(timeoutMs: number) {
    server.close();
    for (const res of active)
      if (
        String(res.getHeader("content-type") ?? "").startsWith(
          "text/event-stream",
        )
      )
        res.end();
    server.closeIdleConnections();
    if (active.size)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        idle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    server.closeAllConnections();
  };
}
