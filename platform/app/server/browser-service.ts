import { companionInternalRoutes } from "../shared/cloud-connection.js";
import { readMachineToken } from "./cloud-ingress.js";

/** Remote deployments reach the Mac only through a loopback SSH forward. */
function loopbackOrigin(value: string | undefined, fallback: string) {
  const url = new URL(value ?? fallback);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Browser transport must be an HTTP loopback origin");
  return url.origin;
}

function companionOrigin() {
  const value = process.env.FIELDWORK_COMPANION_ORIGIN;
  return value ? loopbackOrigin(value, value) : null;
}

export const liveBrowserOrigin = () =>
  companionOrigin()
    ? `${companionOrigin()}${companionInternalRoutes.browserLive}`
    : loopbackOrigin(
        process.env.FIELDWORK_LIVE_BROWSER_ORIGIN,
        "http://127.0.0.1:61822",
      );

export const cleanBrowserMcpUrl = () =>
  companionOrigin()
    ? `${companionOrigin()}${companionInternalRoutes.browserCleanMcp}`
    : `${loopbackOrigin(
        process.env.FIELDWORK_CLEAN_BROWSER_ORIGIN,
        "http://localhost:8931",
      )}/mcp`;

export function browserTransportHeaders(): Record<string, string> {
  if (!companionOrigin()) return {};
  return {
    "X-Fieldwork-Machine-Token": readMachineToken(
      process.env.FIELDWORK_MACHINE_TOKEN_FILE,
    ),
  };
}
