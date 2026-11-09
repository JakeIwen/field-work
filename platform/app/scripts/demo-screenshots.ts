import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { platformDocs } from "../server/paths.js";
import { startDemo } from "./demo-runtime.js";
import { demoCaptureCode } from "./demo-capture.js";

const demo = await startDemo([], { browserPort: 8931 });
const directory = path.join(platformDocs, "screenshots");
mkdirSync(directory, { recursive: true });
const client = new Client({
  name: "fieldwork-synthetic-screenshots",
  version: "1.0.0",
});
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost:8931/mcp")),
  );
  const result = await client.callTool(
    {
      name: "browser_run_code_unsafe",
      arguments: { code: demoCaptureCode(demo.url, directory) },
    },
    undefined,
    { timeout: 600000 },
  );
  if (result.isError) throw new Error(JSON.stringify(result.content));
  console.log(JSON.stringify(result.content, null, 2));
  const outbound = readFileSync(demo.logFile, "utf8").trim();
  console.log(`Backend outbound requests: ${outbound || "[]"}`);
  writeFileSync(
    path.join(directory, "capture-network.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        browserOutbound: [],
        browserErrors: [],
        backendOutbound: outbound
          ? outbound.split("\n").map((line) => JSON.parse(line))
          : [],
      },
      null,
      2,
    ) + "\n",
  );
  if (outbound)
    throw new Error("Demo attempted an outbound connection; inspect its log.");
} catch (error) {
  console.error(
    "Capture failed. Check the configured browser MCP service endpoint and health.",
  );
  throw error;
} finally {
  await client.close();
  await demo.close();
}
