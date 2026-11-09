import { once } from "node:events";
import { createServer } from "node:http";

export async function listenOnEphemeralPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return { server, port: address.port };
}
