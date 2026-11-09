import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { trackResponses } from "../server/http-drain.js";

const half = "x".repeat(64 * 1024);

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  const drain = trackResponses(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { server, drain, port };
}

function read(port: number, path: string) {
  let gotHeaders!: () => void;
  const headers = new Promise<void>((resolve) => (gotHeaders = resolve));
  const body = new Promise<{ text: string; complete: boolean }>((resolve) => {
    const request = http.get({ port, path, host: "127.0.0.1" }, (res) => {
      gotHeaders();
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("close", () => resolve({ text, complete: res.complete }));
    });
    request.on("error", () => resolve({ text: "", complete: false }));
  });
  return { headers, body };
}

test("drain finishes in-flight responses and ends event streams before closing", async () => {
  const { drain, port } = await listen((req, res) => {
    if (req.url === "/events") {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('data: {"type":"connected"}\n\n');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.write(half);
    setTimeout(() => res.end(half), 150);
  });
  const state = read(port, "/state");
  const events = read(port, "/events");
  await Promise.all([state.headers, events.headers]);
  await drain(5_000);
  const [body, stream] = await Promise.all([state.body, events.body]);
  assert.equal(body.complete, true);
  assert.equal(body.text.length, half.length * 2);
  assert.equal(stream.complete, true, "event streams are ended cleanly");
});

test("drain stops waiting for a response that never finishes", async () => {
  const { drain, port } = await listen((_req, res) => res.write(half));
  const stuck = read(port, "/stuck");
  await stuck.headers;
  const started = Date.now();
  await drain(100);
  assert.ok(Date.now() - started < 2_000);
  assert.equal((await stuck.body).complete, false);
});
