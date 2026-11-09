import { execFile, type ExecFileOptions } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import {
  remoteRenderOperations,
  type RemoteRenderFile,
  type RemoteRenderRequest,
  type RemoteRenderResponse,
} from "../shared/remote-render.js";
import { sha256 } from "./storage.js";

const maxFileBytes = 12 * 1024 * 1024;
const maxTotalBytes = 24 * 1024 * 1024;

type Execution = { stdout: string; stderr: string };
export type RemoteRenderExecutor = (
  command: string,
  args: string[],
  options: ExecFileOptions & { signal: AbortSignal },
) => Promise<Execution>;

export type RemoteRenderHandlerOptions = {
  root: string;
  dataDir: string;
  token: string;
  concurrency?: number;
  execute?: RemoteRenderExecutor;
};

type ProcessError = Error & { stdout?: string; stderr?: string };

class RenderRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function executeNativeRenderer(
  command: string,
  args: string[],
  options: ExecFileOptions & { signal: AbortSignal },
): Promise<Execution> {
  const { signal, ...processOptions } = options;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let force: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      command,
      args,
      { ...processOptions, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout, stderr) => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(force);
        if (signal.aborted) error ??= new Error("Rendering cancelled");
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else resolve({ stdout, stderr });
      },
    );
    function cancel() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
    }
    // execFile's AbortSignal callback can precede process exit. Killing manually
    // keeps this promise pending until execFile observes the child's close.
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function authorized(supplied: string | undefined, expected: string) {
  const left = Buffer.from(supplied ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function requestBody(req: Parameters<RequestHandler>[0]) {
  if (req.body !== undefined) return req.body;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 34 * 1024 * 1024)
      throw new RenderRequestError("Remote render request is too large", 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RenderRequestError("Invalid remote render JSON");
  }
}

function decodeFile(value: unknown): { name: string; bytes: Buffer } {
  const file = value as RemoteRenderFile;
  if (
    !file ||
    typeof file.name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(file.name) ||
    typeof file.bytes !== "string" ||
    typeof file.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(file.hash)
  )
    throw new RenderRequestError("Invalid render input");
  const bytes = Buffer.from(file.bytes, "base64");
  if (
    bytes.length > maxFileBytes ||
    bytes.toString("base64") !== file.bytes ||
    sha256(bytes) !== file.hash
  )
    throw new RenderRequestError("Render input failed size or hash validation");
  return { name: file.name, bytes };
}

function validateRequest(value: unknown) {
  const request = value as RemoteRenderRequest;
  if (
    !request ||
    request.schemaVersion !== 1 ||
    !remoteRenderOperations.includes(request.operation) ||
    !Array.isArray(request.files) ||
    (request.coverLetter !== undefined &&
      typeof request.coverLetter !== "boolean")
  )
    throw new RenderRequestError("Invalid remote render request");
  const files = request.files.map(decodeFile);
  if (
    files.reduce((total, file) => total + file.bytes.length, 0) > maxTotalBytes
  )
    throw new RenderRequestError("Remote render request is too large", 413);
  const expected =
    request.operation === "resume"
      ? ["input.html"]
      : request.operation === "cover-letter"
        ? ["letter.txt", "contact.md"]
        : null;
  const validVerificationName = (name: string, index: number) =>
    name === `input-${index}` ||
    (index > 0 && name === `input-${index}_public.pdf`);
  if (
    (expected !== null &&
      (files.length !== expected.length ||
        files.some((file, index) => file.name !== expected[index]))) ||
    (request.operation === "verify-pdf" &&
      (files.length < 2 ||
        files.length > 3 ||
        files.some((file, index) => !validVerificationName(file.name, index))))
  )
    throw new RenderRequestError("Unexpected inputs for render operation");
  return { request, files };
}

function trustedRenderer(root: string, request: RemoteRenderRequest) {
  if (
    !request.renderer ||
    !/^source_master_template\/v\d+(?:_[a-z]+)?\/render_resume\.swift$/.test(
      request.renderer.path,
    ) ||
    !/^[a-f0-9]{64}$/.test(request.renderer.hash)
  )
    throw new RenderRequestError("Invalid resume renderer identity");
  const configuredRoot = realpathSync(root);
  const renderer = path.resolve(configuredRoot, request.renderer.path);
  let resolved: string;
  try {
    resolved = realpathSync(renderer);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new RenderRequestError(
        `The connected Mac needs the approved renderer ${request.renderer.path}. Deploy its trusted tooling before retrying.`,
        503,
      );
    throw error;
  }
  if (
    resolved !== renderer ||
    !resolved.startsWith(configuredRoot + path.sep) ||
    !lstatSync(resolved).isFile() ||
    sha256(readFileSync(resolved)) !== request.renderer.hash
  )
    throw new RenderRequestError("Trusted resume renderer hash mismatch", 409);
  return resolved;
}

function trustedPlatformScript(
  options: RemoteRenderHandlerOptions,
  request: RemoteRenderRequest,
) {
  const name =
    request.operation === "cover-letter"
      ? "render-cover-letter.swift"
      : "verify-pdf.swift";
  const expected = `platform/app/scripts/${name}`;
  if (
    request.renderer?.path !== expected ||
    !/^[a-f0-9]{64}$/.test(request.renderer.hash)
  )
    throw new RenderRequestError("Invalid platform renderer identity");
  const script = path.join(options.root, expected);
  const resolved = realpathSync(script);
  if (
    resolved !== script ||
    !lstatSync(resolved).isFile() ||
    sha256(readFileSync(resolved)) !== request.renderer.hash
  )
    throw new RenderRequestError(
      "Trusted platform renderer hash mismatch",
      409,
    );
  return script;
}

function commandFor(
  options: RemoteRenderHandlerOptions,
  request: RemoteRenderRequest,
  scratch: string,
) {
  const cache = path.join(options.dataDir, "swift-cache");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const prefix = ["-module-cache-path", cache];
  if (request.operation === "resume")
    return {
      args: [
        ...prefix,
        trustedRenderer(options.root, request),
        path.join(scratch, "input.html"),
        path.join(scratch, "output.pdf"),
      ],
      outputs: ["output.pdf"],
    };
  const script = trustedPlatformScript(options, request);
  if (request.operation === "cover-letter")
    return {
      args: [
        ...prefix,
        script,
        path.join(scratch, "letter.txt"),
        path.join(scratch, "contact.md"),
        path.join(scratch, "output.pdf"),
      ],
      outputs: ["output.pdf"],
    };
  return {
    args: [
      ...prefix,
      script,
      ...(request.coverLetter ? ["--cover-letter"] : []),
      ...request.files.map((file) => path.join(scratch, file.name)),
    ],
    outputs: [],
  };
}

function outputFile(scratch: string, name: string): RemoteRenderFile {
  const bytes = readFileSync(path.join(scratch, name));
  if (bytes.length > maxFileBytes)
    throw new RenderRequestError("Remote render output is too large", 500);
  return { name, bytes: bytes.toString("base64"), hash: sha256(bytes) };
}

export function createRemoteRenderHandler(
  options: RemoteRenderHandlerOptions,
): RequestHandler {
  const execute = options.execute ?? executeNativeRenderer;
  const limit = options.concurrency ?? 3;
  let active = 0;
  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    if (!authorized(req.header("x-fieldwork-machine-token"), options.token)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (active >= limit) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "Renderer is busy" });
      return;
    }
    active++;
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    let scratch: string | undefined;
    try {
      const directory = mkdtempSync(
        path.join(
          options.dataDir,
          `remote-render-${randomBytes(4).toString("hex")}-`,
        ),
      );
      scratch = directory;
      const { request, files } = validateRequest(await requestBody(req));
      for (const file of files)
        writeFileSync(path.join(directory, file.name), file.bytes, {
          mode: 0o600,
          flag: "wx",
        });
      const command = commandFor(options, request, directory);
      const result = await execute("swift", command.args, {
        signal: controller.signal,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      const response: RemoteRenderResponse = {
        schemaVersion: 1,
        stdout: result.stdout,
        stderr: result.stderr,
        outputs: command.outputs.map((name) => outputFile(directory, name)),
      };
      res.json(response);
    } catch (error: unknown) {
      const status = error instanceof RenderRequestError ? error.status : 422;
      const processError = error as ProcessError;
      if (!res.headersSent)
        res.status(status).json({
          error: error instanceof Error ? error.message : String(error),
          ...(typeof processError?.stdout === "string"
            ? { stdout: processError.stdout }
            : {}),
          ...(typeof processError?.stderr === "string"
            ? { stderr: processError.stderr }
            : {}),
        });
    } finally {
      try {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      } finally {
        active--;
      }
    }
  };
}
