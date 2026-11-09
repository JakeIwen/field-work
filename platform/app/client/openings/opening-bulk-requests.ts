import { api } from "../workspace/api";

type OpeningBulkRequest = { id: string; path: string; body: unknown };
const concurrentRequests = 4;

/** Leave room for the live event stream and state reads on HTTP/1.1 connections. */
export async function runOpeningBulkRequests(
  requests: OpeningBulkRequest[],
  refresh: () => Promise<void>,
  progress: (completed: number) => void,
) {
  const succeeded: string[] = [];
  let next = 0, completed = 0, failed = 0;
  async function worker() {
    while (next < requests.length) {
      const request = requests[next++];
      try {
        await api(request.path, request.body);
        succeeded.push(request.id);
      } catch { failed++; }
      progress(++completed);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentRequests, requests.length) }, worker));
  // Refresh after every write has settled, including when the final write failed.
  let refreshFailed = false;
  try { await refresh(); } catch { refreshFailed = true; }
  return { succeeded, failed, refreshFailed };
}
