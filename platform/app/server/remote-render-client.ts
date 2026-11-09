import { tunableMsOr, tunableOr, type TimeTunableKey } from "./tunables.js";
import type { TunableKey } from "../shared/tunables.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ExecFileOptions } from "node:child_process";
import type {
  RemoteRenderFile,
  RemoteRenderOperation,
  RemoteRenderRequest,
  RemoteRenderResponse,
} from "../shared/remote-render.js";
import { atomicWrite, sha256, type Store } from "./storage.js";

const maxInputBytes = 24 * 1024 * 1024;
const maxOutputBytes = 12 * 1024 * 1024;
const maxResponseBytes = 18 * 1024 * 1024;
const coverRenderer = fileURLToPath(
  new URL("../scripts/render-cover-letter.swift", import.meta.url),
);
const pdfVerifier = fileURLToPath(
  new URL("../scripts/verify-pdf.swift", import.meta.url),
);

type RemotePlan = {
  request: RemoteRenderRequest;
  outputs: { name: string; path: string }[];
};

class RemoteRenderError extends Error {
  stdout = "";
  stderr = "";
  constructor(message: string, detail?: { stdout?: string; stderr?: string }) {
    super(message);
    this.stdout = detail?.stdout ?? "";
    this.stderr = detail?.stderr ?? "";
  }
}

export function remoteRenderConfigured() {
  return Boolean(
    process.env.FIELDWORK_RENDER_URL &&
    process.env.FIELDWORK_MACHINE_TOKEN_FILE,
  );
}

function file(name: string, source: string): RemoteRenderFile {
  const bytes = readFileSync(source);
  return {
    name,
    bytes: bytes.toString("base64"),
    hash: sha256(bytes),
  };
}

function verificationInputName(source: string, index: number) {
  return index > 0 && path.basename(source).endsWith("_public.pdf")
    ? `input-${index}_public.pdf`
    : `input-${index}`;
}

function swiftArguments(args: string[]) {
  if (args[0] !== "-module-cache-path" || args.length < 4)
    throw new Error("Unsupported remote Swift invocation");
  return args.slice(2);
}

function request(
  operation: RemoteRenderOperation,
  files: RemoteRenderFile[],
  extra: Pick<RemoteRenderRequest, "renderer" | "coverLetter">,
): RemoteRenderRequest {
  const total = files.reduce(
    (bytes, value) => bytes + Buffer.byteLength(value.bytes, "base64"),
    0,
  );
  if (total > maxInputBytes)
    throw new Error("Remote render inputs are too large");
  return { schemaVersion: 1, operation, files, ...extra };
}

function resumeRendererIdentity(store: Store, renderer: string) {
  const relative = path.relative(store.root, renderer);
  if (relative.startsWith(".."))
    throw new Error("Renderer is outside the configured source checkout");
  return { path: relative, hash: sha256(readFileSync(renderer)) };
}

function platformRendererIdentity(renderer: string, expected: string) {
  if (path.resolve(renderer) !== path.resolve(expected))
    throw new Error("Unexpected installed platform renderer path");
  return {
    path: `platform/app/scripts/${path.basename(expected)}`,
    hash: sha256(readFileSync(expected)),
  };
}

export function remoteRenderPlan(
  store: Store,
  command: string,
  args: string[],
): RemotePlan | undefined {
  if (!remoteRenderConfigured() || path.basename(command) !== "swift") return;
  const values = swiftArguments(args);
  const renderer = values[0];
  if (path.basename(renderer) === "render-cover-letter.swift") {
    if (values.length !== 4)
      throw new Error("Invalid cover-letter render command");
    return {
      request: request(
        "cover-letter",
        [file("letter.txt", values[1]), file("contact.md", values[2])],
        { renderer: platformRendererIdentity(renderer, coverRenderer) },
      ),
      outputs: [{ name: "output.pdf", path: values[3] }],
    };
  }
  if (path.basename(renderer) === "verify-pdf.swift") {
    const coverLetter = values[1] === "--cover-letter";
    const inputs = values.slice(coverLetter ? 2 : 1);
    if (inputs.length < 2 || inputs.length > 3)
      throw new Error("Invalid PDF verification command");
    return {
      request: request(
        "verify-pdf",
        inputs.map((value, index) =>
          file(verificationInputName(value, index), value),
        ),
        {
          coverLetter,
          renderer: platformRendererIdentity(renderer, pdfVerifier),
        },
      ),
      outputs: [],
    };
  }
  const relative = path.relative(store.root, renderer);
  if (
    values.length !== 3 ||
    relative.startsWith("..") ||
    !/^source_master_template\/v\d+(?:_[a-z]+)?\/render_resume\.swift$/.test(
      relative,
    )
  )
    throw new Error("Remote rendering allows only captured resume renderers");
  return {
    request: request("resume", [file("input.html", values[1])], {
      renderer: resumeRendererIdentity(store, renderer),
    }),
    outputs: [{ name: "output.pdf", path: values[2] }],
  };
}

function parseResponse(value: unknown): RemoteRenderResponse {
  if (!value || typeof value !== "object")
    throw new RemoteRenderError("Remote renderer returned invalid JSON");
  const response = value as RemoteRenderResponse;
  if (
    response.schemaVersion !== 1 ||
    typeof response.stdout !== "string" ||
    response.stdout.length > 1024 * 1024 ||
    typeof response.stderr !== "string" ||
    response.stderr.length > 1024 * 1024 ||
    !Array.isArray(response.outputs) ||
    response.outputs.length > 1
  )
    throw new RemoteRenderError("Remote renderer returned an invalid response");
  return response;
}

async function boundedJson(response: Response) {
  if (!response.body)
    throw new RemoteRenderError("Remote renderer returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel();
      throw new RemoteRenderError("Remote renderer response is too large");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    );
  } catch {
    throw new RemoteRenderError("Remote renderer returned invalid JSON");
  }
}

function outputBytes(output: RemoteRenderFile) {
  if (
    !output ||
    typeof output.name !== "string" ||
    typeof output.bytes !== "string" ||
    output.bytes.length > Math.ceil((maxOutputBytes * 4) / 3) + 4 ||
    typeof output.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(output.hash)
  )
    throw new RemoteRenderError("Remote renderer returned an invalid output");
  const bytes = Buffer.from(output.bytes, "base64");
  if (
    bytes.length > maxOutputBytes ||
    bytes.toString("base64") !== output.bytes ||
    sha256(bytes) !== output.hash
  )
    throw new RemoteRenderError("Remote renderer output failed validation");
  if (bytes.subarray(0, 4).toString() !== "%PDF")
    throw new RemoteRenderError("Remote renderer output is not a PDF");
  return bytes;
}

async function requestRemoteRender(
  url: string,
  token: string,
  plan: RemotePlan,
  requestSignal: AbortSignal,
  read: (key: TunableKey) => number,
  readMs: (key: TimeTunableKey) => number,
) {
  let response!: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Host: "127.0.0.1:4317",
          "X-Fieldwork-Machine-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(plan.request),
        signal: requestSignal,
      });
    } catch (error) {
      // Rendering is a pure function of the request, so a connection lost
      // before any answer (a pooled socket the Mac closed while its last answer
      // was still crossing the tunnel) is safe to send again.
      if (
        requestSignal.aborted ||
        attempt >= read("documents.remoteRenderAttempts")
      )
        throw error;
      await delay(readMs("documents.remoteRenderRetryDelayS"), undefined, {
        signal: requestSignal,
      });
      continue;
    }
    if (
      response.status !== 429 ||
      attempt >= read("documents.remoteRenderAttempts")
    )
      break;
    await delay(readMs("documents.remoteRenderRetryDelayS"), undefined, {
      signal: requestSignal,
    });
  }
  return response;
}

export async function runRemoteRender(
  plan: RemotePlan,
  signal: AbortSignal,
  options: Omit<ExecFileOptions, "signal" | "encoding">,
  store?: Store,
) {
  const url = process.env.FIELDWORK_RENDER_URL!;
  const token = readFileSync(
    process.env.FIELDWORK_MACHINE_TOKEN_FILE!,
    "utf8",
  ).trim();
  if (!token) throw new Error("Fieldwork renderer token is empty");
  const read = (key: TunableKey) => tunableOr(store, key);
  const readMs = (key: TimeTunableKey) => tunableMsOr(store, key);
  const timeout =
    typeof options.timeout === "number" && options.timeout > 0
      ? options.timeout
      : readMs("documents.renderTimeoutS");
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(
      Math.min(
        timeout + readMs("documents.remoteRenderDeadlineAllowanceS"),
        readMs("documents.remoteRenderDeadlineCeilingS"),
      ),
    ),
  ]);
  const response = await requestRemoteRender(
    url,
    token,
    plan,
    requestSignal,
    read,
    readMs,
  );
  const value = await boundedJson(response);
  if (!response.ok) {
    const detail = value && typeof value === "object" ? value : {};
    throw new RemoteRenderError(
      typeof detail.error === "string"
        ? detail.error
        : `Remote renderer HTTP ${response.status}`,
      detail,
    );
  }
  const result = parseResponse(value);
  if (result.outputs.length !== plan.outputs.length)
    throw new RemoteRenderError("Remote renderer returned unexpected outputs");
  for (const expected of plan.outputs) {
    const output = result.outputs.find((item) => item.name === expected.name);
    if (!output)
      throw new RemoteRenderError("Remote renderer omitted an output");
    const bytes = outputBytes(output);
    atomicWrite(expected.path, bytes);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
