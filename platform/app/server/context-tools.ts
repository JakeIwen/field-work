import { isTaskTurnActive } from "../shared/types.js";
import { readFileSync } from "node:fs";
import {
  Store,
  HttpError,
  MissingRecordError,
  sha256,
  atomicWrite,
} from "./storage.js";
import { draftPath, writeDraftArtifact } from "./bundles.js";
import { maxContextSourceBytes } from "./context-source-limits.js";
import {
  dispatchTaskSourceTool,
  taskSourceToolPolicy,
} from "./task-kinds/registry.js";

export const contextReadTool = {
  type: "function",
  name: "read_job_search_source",
  description:
    "Read a captured job-search source by exact relative path from context-manifest.json. Start by reading context-manifest.json. Returns text plus content hash. No arbitrary filesystem access.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
export const contextWriteTool = {
  type: "function",
  name: "write_application_source",
  description:
    "Write an allowed application draft source. Read it first and supply its exact current hash to avoid overwriting concurrent edits. Allowed paths are in DOCUMENT-INSTRUCTIONS.md. The backend, not this tool, renders and validates PDFs.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      expectedHash: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "expectedHash", "content"],
    additionalProperties: false,
  },
};
export function contextTool(
  store: Store,
  threadId: string,
  tool: string,
  args: any,
): any {
  const task = store.taskForThread(threadId);
  if (
    !task ||
    task.threadId !== threadId ||
    !taskSourceToolPolicy(task).eligible
  )
    throw new HttpError(
      403,
      "This conversation has no question/document source tools",
    );
  const dispatched = dispatchTaskSourceTool(store, task, tool, args);
  if (dispatched.handled) return dispatched.result;
  if (!args || typeof args.path !== "string" || args.path.length > 1000)
    throw new HttpError(400, "An exact context source path is required");
  const paths = new Set([
    ...(task.manifest?.paths ?? []),
    "context-manifest.json",
  ]);
  if (tool === "read_job_search_source") {
    if (!paths.has(args.path) || !/\.(md|txt|html|json)$/.test(args.path))
      throw new HttpError(
        403,
        "That source is not included in this conversation",
      );
    const bytes = readFileSync(draftPath(store, task.id, args.path));
    if (bytes.length > maxContextSourceBytes)
      throw new HttpError(413, "Source is too large");
    return {
      path: args.path,
      hash: sha256(bytes),
      text: bytes.toString("utf8"),
    };
  }
  const allowedWritePaths = taskSourceToolPolicy(task).allowedWritePaths;
  if (tool !== "write_application_source" || !allowedWritePaths)
    throw new HttpError(403, "This conversation cannot write documents");
  if (
    task.documentResult?.status === "rendering" ||
    !isTaskTurnActive(task.status)
  )
    throw new HttpError(
      409,
      "Draft writes require an active document turn and cannot overlap PDF generation",
    );
  const bundle = store.get("bundle", task.id);
  if (!bundle)
    throw new MissingRecordError(
      409,
      "bundle",
      task.id,
      "This conversation's draft bundle is missing.",
    );
  const allowed = allowedWritePaths(task, bundle);
  if (
    !allowed.includes(args.path) ||
    typeof args.content !== "string" ||
    args.content.length > 200000 ||
    typeof args.expectedHash !== "string"
  )
    throw new HttpError(
      403,
      "This document path or content is not an allowed draft write",
    );
  const result = writeDraftArtifact(
    store,
    task.id,
    args.path,
    args.expectedHash,
    args.content,
  );
  atomicWrite(
    draftPath(
      store,
      task.id,
      `source-history/${sha256(args.path)}/${sha256(args.content)}.txt`,
    ),
    args.content,
  );
  return {
    ...result,
    bytes: Buffer.byteLength(args.content),
    message: "Draft source saved. PDFs are generated after the turn completes.",
  };
}
