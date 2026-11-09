import { sampleWorkspaceRoot } from "../fixtures/sample-workspace.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import {
  createRemoteRenderHandler,
  executeNativeRenderer,
  type RemoteRenderExecutor,
} from "../../server/remote-render-handler.js";
import { runGenerationProcess } from "../../server/generation-control.js";
import { remoteRenderPlan } from "../../server/remote-render-client.js";
import { sha256, Store } from "../../server/storage.js";
import type { RemoteRenderRequest } from "../../shared/remote-render.js";

function file(name: string, text: string) {
  const bytes = Buffer.from(text);
  return { name, bytes: bytes.toString("base64"), hash: sha256(bytes) };
}

async function fixture(execute?: RemoteRenderExecutor) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "fieldwork-render-test-")),
  );
  const dataDir = path.join(root, ".data");
  const rendererDir = path.join(root, "source_master_template/v1");
  mkdirSync(dataDir);
  mkdirSync(rendererDir, { recursive: true });
  const renderer = path.join(rendererDir, "render_resume.swift");
  writeFileSync(renderer, "// trusted renderer\n");
  const app = express();
  app.post(
    "/render",
    createRemoteRenderHandler({
      root,
      dataDir,
      token: "machine-secret",
      execute:
        execute ??
        (async (_command, args) => {
          const output = args.at(-1)!;
          writeFileSync(output, "%PDF-remote-result");
          return { stdout: "validated\n", stderr: "" };
        }),
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    root,
    dataDir,
    renderer,
    url: `http://127.0.0.1:${address.port}/render`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(renderer: string): RemoteRenderRequest {
  return {
    schemaVersion: 1,
    operation: "resume",
    renderer: {
      path: "source_master_template/v1/render_resume.swift",
      hash: sha256(readFileSync(renderer)),
    },
    files: [file("input.html", "<html>resume</html>")],
  };
}

test("remote renderer accepts only authenticated, hash-bound operations", async () => {
  const f = await fixture();
  try {
    const unauthorized = await fetch(f.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request(f.renderer)),
    });
    assert.equal(unauthorized.status, 401);

    const valid = await fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request(f.renderer)),
    });
    assert.equal(valid.status, 200);
    const result = await valid.json();
    assert.equal(result.stdout, "validated\n");
    assert.equal(
      Buffer.from(result.outputs[0].bytes, "base64").subarray(0, 4).toString(),
      "%PDF",
    );

    const changed = request(f.renderer);
    changed.renderer.hash = "0".repeat(64);
    const conflict = await fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(changed),
    });
    assert.equal(conflict.status, 409);
  } finally {
    await f.close();
  }
});

test("remote renderer rejects undeclared inputs before execution", async () => {
  const f = await fixture();
  try {
    const invalid = request(f.renderer);
    invalid.files[0].name = "../input.html";
    const response = await fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invalid),
    });
    assert.equal(response.status, 400);
  } finally {
    await f.close();
  }
});

test("PDF verification preserves only the bounded public filename semantic", async () => {
  let executedNames: string[] = [];
  const f = await fixture(async (_command, args) => {
    executedNames = args.slice(-3).map((value) => path.basename(value));
    return { stdout: "validated\n", stderr: "" };
  });
  const verifier = path.join(f.root, "platform/app/scripts/verify-pdf.swift");
  mkdirSync(path.dirname(verifier), { recursive: true });
  writeFileSync(verifier, "// trusted verifier\n");
  const body: RemoteRenderRequest = {
    schemaVersion: 1,
    operation: "verify-pdf",
    renderer: {
      path: "platform/app/scripts/verify-pdf.swift",
      hash: sha256(readFileSync(verifier)),
    },
    files: [
      file("input-0", "source"),
      file("input-1", "%PDF-private"),
      file("input-2_public.pdf", "%PDF-public"),
    ],
  };
  const post = (value: RemoteRenderRequest) =>
    fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await post(body)).status, 200);
    assert.deepEqual(executedNames, [
      "input-0",
      "input-1",
      "input-2_public.pdf",
    ]);
    const arbitrary = structuredClone(body);
    arbitrary.files[2].name = "input-2_other.pdf";
    assert.equal((await post(arbitrary)).status, 400);
    const sourcePublic = structuredClone(body);
    sourcePublic.files[0].name = "input-0_public.pdf";
    assert.equal((await post(sourcePublic)).status, 400);
  } finally {
    await f.close();
  }
});

test("generation control writes hash-checked remote renderer output", async () => {
  const f = await fixture();
  const dataDir = path.join(f.root, ".store");
  const tokenFile = path.join(f.root, "machine-token");
  const input = path.join(f.root, "input.html");
  const output = path.join(f.root, "output.pdf");
  writeFileSync(tokenFile, "machine-secret\n", { mode: 0o600 });
  writeFileSync(input, "<html>resume</html>");
  const store = new Store(f.root, dataDir);
  const prior = {
    url: process.env.FIELDWORK_RENDER_URL,
    token: process.env.FIELDWORK_MACHINE_TOKEN_FILE,
  };
  process.env.FIELDWORK_RENDER_URL = f.url;
  process.env.FIELDWORK_MACHINE_TOKEN_FILE = tokenFile;
  try {
    const result = await runGenerationProcess(
      store,
      "swift",
      [
        "-module-cache-path",
        path.join(dataDir, "swift-cache"),
        f.renderer,
        input,
        output,
      ],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.stdout, "validated\n");
    assert.equal(readFileSync(output, "utf8"), "%PDF-remote-result");
  } finally {
    store.close();
    if (prior.url === undefined) delete process.env.FIELDWORK_RENDER_URL;
    else process.env.FIELDWORK_RENDER_URL = prior.url;
    if (prior.token === undefined)
      delete process.env.FIELDWORK_MACHINE_TOKEN_FILE;
    else process.env.FIELDWORK_MACHINE_TOKEN_FILE = prior.token;
    await f.close();
  }
});

test("installed platform renderers remain valid outside the Store root", async () => {
  const f = await fixture();
  const store = new Store(f.root, path.join(f.root, ".split-store"));
  const tokenFile = path.join(f.root, "split-token");
  const letter = path.join(f.root, "letter.txt");
  const contact = path.join(f.root, "contact.md");
  const output = path.join(f.root, "letter.pdf");
  const installed = fileURLToPath(
    new URL("../../scripts/render-cover-letter.swift", import.meta.url),
  );
  writeFileSync(tokenFile, "machine-secret\n");
  writeFileSync(letter, "letter");
  writeFileSync(contact, "contact");
  const prior = {
    url: process.env.FIELDWORK_RENDER_URL,
    token: process.env.FIELDWORK_MACHINE_TOKEN_FILE,
  };
  process.env.FIELDWORK_RENDER_URL = f.url;
  process.env.FIELDWORK_MACHINE_TOKEN_FILE = tokenFile;
  try {
    const plan = remoteRenderPlan(store, "swift", [
      "-module-cache-path",
      path.join(f.root, "cache"),
      installed,
      letter,
      contact,
      output,
    ]);
    assert.equal(plan?.request.operation, "cover-letter");
    assert.equal(
      plan?.request.renderer?.path,
      "platform/app/scripts/render-cover-letter.swift",
    );
    assert.equal(plan?.request.renderer?.hash, sha256(readFileSync(installed)));
    const verifier = fileURLToPath(
      new URL("../../scripts/verify-pdf.swift", import.meta.url),
    );
    const source = path.join(f.root, "resume.html");
    const privatePdf = path.join(f.root, "resume_private.pdf");
    const publicPdf = path.join(f.root, "resume_public.pdf");
    writeFileSync(source, "<html>resume</html>");
    writeFileSync(privatePdf, "%PDF-private");
    writeFileSync(publicPdf, "%PDF-public");
    const verification = remoteRenderPlan(store, "swift", [
      "-module-cache-path",
      path.join(f.root, "verify-cache"),
      verifier,
      source,
      privatePdf,
      publicPdf,
    ]);
    assert.deepEqual(
      verification?.request.files.map((input) => input.name),
      ["input-0", "input-1", "input-2_public.pdf"],
    );
  } finally {
    store.close();
    if (prior.url === undefined) delete process.env.FIELDWORK_RENDER_URL;
    else process.env.FIELDWORK_RENDER_URL = prior.url;
    if (prior.token === undefined)
      delete process.env.FIELDWORK_MACHINE_TOKEN_FILE;
    else process.env.FIELDWORK_MACHINE_TOKEN_FILE = prior.token;
    await f.close();
  }
});

test("aborting the HTTP request cancels and awaits remote execution", async () => {
  let started!: () => void;
  let cancelled!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  const didCancel = new Promise<void>((resolve) => (cancelled = resolve));
  const f = await fixture(
    (_command, _args, options) =>
      new Promise((_resolve, reject) => {
        started();
        options.signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
  );
  try {
    const controller = new AbortController();
    const pending = fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request(f.renderer)),
      signal: controller.signal,
    });
    await didStart;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await didCancel;
  } finally {
    await f.close();
  }
});

test(
  "remote handler runs the trusted macOS cover-letter renderer",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    const root = realpathSync(
      fileURLToPath(new URL("../../../../", import.meta.url)),
    );
    const dataDir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "fieldwork-actual-render-")),
    );
    const script = path.join(
      root,
      "platform/app/scripts/render-cover-letter.swift",
    );
    const contact = readFileSync(
      path.join(sampleWorkspaceRoot, "source_data/resume.md"),
      "utf8",
    );
    const app = express();
    app.post(
      "/render",
      createRemoteRenderHandler({ root, dataDir, token: "machine-secret" }),
    );
    const server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const body: RemoteRenderRequest = {
        schemaVersion: 1,
        operation: "cover-letter",
        renderer: {
          path: "platform/app/scripts/render-cover-letter.swift",
          hash: sha256(readFileSync(script)),
        },
        files: [
          file(
            "letter.txt",
            "Dear Hiring Team,\n\nI am applying for this role. My experience aligns with the work.\n\nSincerely,\nSam Rivera",
          ),
          file("contact.md", contact),
        ],
      };
      const response = await fetch(`http://127.0.0.1:${address.port}/render`, {
        method: "POST",
        headers: {
          "X-Fieldwork-Machine-Token": "machine-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        assert.fail(
          `Remote renderer HTTP ${response.status}: ${await response.text()}`,
        );
      const result = await response.json();
      assert.equal(
        Buffer.from(result.outputs[0].bytes, "base64")
          .subarray(0, 4)
          .toString(),
        "%PDF",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test("renderer capacity recovers after scratch creation fails", async () => {
  const f = await fixture();
  const post = () =>
    fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request(f.renderer)),
    });
  try {
    rmSync(f.dataDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const failed = await post();
      assert.ok(failed.status >= 400);
      assert.notEqual(failed.status, 429);
      await failed.text();
    }
    mkdirSync(f.dataDir);
    const recovered = await post();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).stdout, "validated\n");
  } finally {
    await f.close();
  }
});

test(
  "native cancellation settles only after a SIGTERM-resistant child exits",
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "fieldwork-native-cancel-"),
    );
    const ready = path.join(directory, "ready");
    const controller = new AbortController();
    const execution = executeNativeRenderer(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
        ready,
      ],
      { signal: controller.signal, timeout: 8000, maxBuffer: 1000 },
    );
    void execution.catch(() => {});
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) await delay(10);
      assert.ok(
        existsSync(ready),
        "fixture child must reach its signal handler",
      );
      const pid = Number(readFileSync(ready, "utf8"));
      controller.abort();
      await assert.rejects(execution);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      controller.abort();
      await execution.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("renderer rejects nonboolean flags and identifies missing trusted tooling", async () => {
  const f = await fixture();
  const post = (body: unknown) =>
    fetch(f.url, {
      method: "POST",
      headers: {
        "X-Fieldwork-Machine-Token": "machine-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const invalid = await post({
      ...request(f.renderer),
      coverLetter: "false",
    });
    assert.equal(invalid.status, 400);
    await invalid.text();
    const missing = request(f.renderer);
    missing.renderer.path = "source_master_template/v2/render_resume.swift";
    const absent = await post(missing);
    assert.equal(absent.status, 503);
    assert.match(
      (await absent.json()).error,
      /connected Mac needs the approved renderer/,
    );
  } finally {
    await f.close();
  }
});

test("remote rendering resends a request whose connection closed before any answer", async () => {
  const f = await fixture();
  let attempts = 0;
  // Drops the first connection unanswered, as a pooled socket the Mac had
  // already closed does, then forwards to the real handler.
  const front = createServer((req, res) => {
    if (++attempts === 1) return void req.socket.destroy();
    const forward = httpRequest(
      f.url,
      { method: req.method, headers: req.headers },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    req.pipe(forward);
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const address = front.address();
  assert(address && typeof address === "object");
  const tokenFile = path.join(f.root, "machine-token");
  const input = path.join(f.root, "input.html");
  const output = path.join(f.root, "output.pdf");
  writeFileSync(tokenFile, "machine-secret\n", { mode: 0o600 });
  writeFileSync(input, "<html>resume</html>");
  const store = new Store(f.root, path.join(f.root, ".store"));
  const prior = {
    url: process.env.FIELDWORK_RENDER_URL,
    token: process.env.FIELDWORK_MACHINE_TOKEN_FILE,
  };
  process.env.FIELDWORK_RENDER_URL = `http://127.0.0.1:${address.port}/render`;
  process.env.FIELDWORK_MACHINE_TOKEN_FILE = tokenFile;
  try {
    const result = await runGenerationProcess(
      store,
      "swift",
      [
        "-module-cache-path",
        path.join(f.root, "swift-cache"),
        f.renderer,
        input,
        output,
      ],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(attempts, 2);
    assert.equal(result.stdout, "validated\n");
    assert.equal(readFileSync(output, "utf8"), "%PDF-remote-result");
  } finally {
    store.close();
    if (prior.url === undefined) delete process.env.FIELDWORK_RENDER_URL;
    else process.env.FIELDWORK_RENDER_URL = prior.url;
    if (prior.token === undefined)
      delete process.env.FIELDWORK_MACHINE_TOKEN_FILE;
    else process.env.FIELDWORK_MACHINE_TOKEN_FILE = prior.token;
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await f.close();
  }
});
