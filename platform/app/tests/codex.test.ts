import { fixture } from "./fixtures/codex-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAdapter, publicCodexValue } from "../server/codex.js";

test("protocol fixture: authenticated discovery, isolated start, follow-up, steer, interruption, restart/resume", async () => {
  const f = fixture();
  let resumed: CodexAdapter | undefined;
  try {
    const status = await f.adapter.connect();
    assert.equal(status.available, true);
    assert.deepEqual(status.selected, {
      model: "gpt-6-astra",
      effort: "high",
    });
    assert.equal(JSON.stringify(status).includes("do-not-store"), false);
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "A bounded request",
    });
    await assert.rejects(
      f.adapter.send(first.threadId, "Another request"),
      /active turn/,
    );
    await f.adapter.steer(first.threadId, "Follow-up during execution");
    const steer = f.messages.find((m) => m.method === "turn/steer");
    assert.equal(steer.params.expectedTurnId, first.turnId);
    const result = await f.adapter.interrupt(first.threadId);
    assert.equal(result.interrupted, true);
    const second = await f.adapter.send(
      first.threadId,
      "Follow-up after completion",
    );
    await f.adapter.interrupt(first.threadId);
    const history = await f.adapter.read(first.threadId);
    assert.equal(history.thread.turns.length, 2);
    const request = f.messages.find((m) => m.method === "turn/start");
    assert.deepEqual(request.params.sandboxPolicy.writableRoots, [f.draft]);
    assert.equal(request.params.sandboxPolicy.excludeSlashTmp, true);
    assert.equal(request.params.approvalsReviewer, "user");
    f.adapter.close();
    resumed = f.create();
    await resumed.connect();
    await resumed.resume(first.threadId);
    assert.equal(
      (await resumed.read(first.threadId)).thread.turns[1].id,
      second.turnId,
    );
  } finally {
    resumed?.close();
    f.cleanup();
  }
});

test("catalog default wins over global config and tasks default to high", async () => {
  const f = fixture({
    defaultModel: "gpt-6-sol",
    configuredModel: "gpt-6-astra",
  });
  try {
    const status = await f.adapter.connect();
    assert.equal(status.selectionPolicy, "codex-default");
    assert.equal(status.defaultEffort, "high");
    assert.deepEqual(status.selected, { model: "gpt-6-sol", effort: "high" });
    await assert.rejects(
      f.adapter.start({ cwd: f.draft, prompt: "Task", effort: "ultra" }),
      /does not support reasoning effort/,
    );
    assert.equal(
      f.messages.some((m) => m.method === "thread/start"),
      false,
    );
    await f.adapter.start({ cwd: f.draft, prompt: "Task" });
    const start = f.messages.find((m) => m.method === "thread/start");
    assert.equal(start.params.model, "gpt-6-sol");
    assert.equal(start.params.allowProviderModelFallback, false);
    assert.equal(start.params.config.model_reasoning_effort, "high");
  } finally {
    f.cleanup();
  }
});

test("missing, ambiguous or unsupported default cannot silently fall back", async () => {
  for (const options of [
    { defaultModel: null },
    { duplicateDefaults: true },
    { defaultWithoutHigh: true },
  ]) {
    const f = fixture(options);
    try {
      const status = await f.adapter.connect();
      assert.equal(status.available, true);
      assert.equal(status.selected, null);
      await assert.rejects(
        f.adapter.start({ cwd: f.draft, prompt: "Task" }),
        /exactly one available default model|does not support reasoning effort/,
      );
      assert.equal(
        f.messages.some((m) => m.method === "thread/start"),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("model and effort substitutions are rejected before a turn starts", async () => {
  for (const options of [
    { returnedModel: "gpt-6-sol" },
    { returnedModel: "" },
    { returnedEffort: "ultra" },
  ]) {
    const f = fixture(options);
    try {
      await assert.rejects(
        f.adapter.start({ cwd: f.draft, prompt: "Task" }),
        /did not confirm the selected model/,
      );
      assert.equal(
        f.messages.some((m) => m.method === "turn/start"),
        false,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("resumed conversations adopt a changed catalog default at high", async () => {
  const options = { defaultModel: "gpt-6-astra" };
  const f = fixture(options);
  try {
    const first = await f.adapter.start({ cwd: f.draft, prompt: "Task" });
    await f.adapter.interrupt(first.threadId);
    options.defaultModel = "gpt-6-sol";
    await f.adapter.send(first.threadId, "Follow-up");
    const resume = f.messages
      .filter((m) => m.method === "thread/resume")
      .at(-1);
    const turn = f.messages.filter((m) => m.method === "turn/start").at(-1);
    assert.equal(resume.params.model, "gpt-6-sol");
    assert.equal(resume.params.config.model_reasoning_effort, "high");
    assert.equal(turn.params.model, "gpt-6-sol");
    assert.equal(turn.params.effort, "high");
    const registry = JSON.parse(
      readFileSync(path.join(f.dataDir, "codex-threads.json"), "utf8"),
    );
    assert.equal(registry.threads[first.threadId].model, "gpt-6-sol");
  } finally {
    f.cleanup();
  }
});

test("refreshing or resuming an active turn preserves its model until it finishes", async () => {
  const options = { defaultModel: "gpt-6-astra" };
  const f = fixture(options);
  try {
    const first = await f.adapter.start({ cwd: f.draft, prompt: "Task" });
    options.defaultModel = "gpt-6-sol";
    await f.adapter.connect(true);
    await f.adapter.resume(first.threadId);
    assert.equal(f.adapter.status().selected?.model, "gpt-6-sol");
    assert.equal(f.adapter.status().threads[0].model, "gpt-6-astra");
    await assert.rejects(
      f.adapter.send(first.threadId, "Must wait"),
      /active turn/,
    );
    assert.equal(f.messages.filter((m) => m.method === "turn/start").length, 1);
    await f.adapter.interrupt(first.threadId);
    await f.adapter.send(first.threadId, "Next turn");
    assert.equal(
      f.messages.filter((m) => m.method === "turn/start").at(-1).params.model,
      "gpt-6-sol",
    );
  } finally {
    f.cleanup();
  }
});

test("legacy ultra threads switch to default/high on their next turn", async () => {
  const f = fixture();
  let resumed: CodexAdapter | undefined;
  try {
    const first = await f.adapter.start({ cwd: f.draft, prompt: "Task" });
    await f.adapter.interrupt(first.threadId);
    f.adapter.close();
    const registryPath = path.join(f.dataDir, "codex-threads.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.threads[first.threadId].effort = "ultra";
    writeFileSync(registryPath, JSON.stringify(registry));
    resumed = f.create();
    await resumed.send(first.threadId, "Follow-up");
    const turn = f.messages.filter((m) => m.method === "turn/start").at(-1);
    assert.equal(turn.params.model, "gpt-6-astra");
    assert.equal(turn.params.effort, "high");
  } finally {
    resumed?.close();
    f.cleanup();
  }
});

test("protocol fixture: API-key auth cannot run a task, unknown IDs and model efforts fail closed", async () => {
  const f = fixture({ auth: "apiKey" });
  try {
    assert.equal((await f.adapter.connect()).available, false);
    await assert.rejects(
      f.adapter.start({ cwd: f.draft, prompt: "Task" }),
      /API-key billing is disabled/,
    );
    await assert.rejects(f.adapter.read("unrelated-thread"), /does not own/);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    await assert.rejects(
      g.adapter.start({
        cwd: g.draft,
        prompt: "Task",
        model: "invented-model",
      }),
      /unavailable/,
    );
    await assert.rejects(
      g.adapter.start({
        cwd: g.draft,
        prompt: "Task",
        effort: "invented-effort",
      }),
      /does not support reasoning effort/,
    );
  } finally {
    g.cleanup();
  }
});

test("protocol fixture: repository roots, symlink escape and broader returned sandbox cannot execute", async () => {
  const f = fixture({ broaderSandbox: true });
  try {
    await assert.rejects(
      f.adapter.start({ cwd: f.root, prompt: "Task" }),
      /never the repository root/,
    );
    const link = path.join(f.dataDir, "outside");
    symlinkSync(os.tmpdir(), link);
    await assert.rejects(
      f.adapter.start({ cwd: link, prompt: "Task" }),
      /isolated draft/,
    );
    await assert.rejects(
      f.adapter.start({ cwd: f.draft, prompt: "Task" }),
      /broader or unverifiable sandbox/,
    );
    assert.equal(
      f.messages.some((m) => m.method === "turn/start"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("protocol fixture: approval and input requests wait for an actual response, no session-wide grants", async () => {
  const f = fixture();
  try {
    const { threadId, turnId } = await f.adapter.start({
      cwd: f.draft,
      prompt: "Task",
    });
    f.notify(
      "item/commandExecution/requestApproval",
      { threadId, turnId, command: "example command" },
      101,
    );
    assert.equal(f.adapter.status().pendingRequests.length, 1);
    assert.equal(
      f.messages.some((m) => m.id === 101),
      false,
    );
    assert.throws(
      () => f.adapter.respond(101, { decision: "acceptForSession" }),
      /Session-wide/,
    );
    f.adapter.respond(101, { decision: "decline" });
    assert.deepEqual(f.messages.find((m) => m.id === 101).result, {
      decision: "decline",
    });
    f.notify(
      "item/tool/requestUserInput",
      {
        threadId,
        turnId,
        questions: [{ id: "q1", question: "Which document?" }],
      },
      102,
    );
    assert.throws(
      () =>
        f.adapter.respond(102, { answers: { wrong: { answers: ["one"] } } }),
      /Invalid question/,
    );
    f.adapter.respond(102, { answers: { q1: { answers: ["one"] } } });
    f.notify("item/permissions/requestApproval", { threadId, turnId }, 103);
    assert.throws(
      () =>
        f.adapter.respond(103, {
          scope: "session",
          permissions: { fileSystem: { write: ["/"] } },
        }),
      /Extra grants/,
    );
    f.adapter.respond(103, { scope: "turn", permissions: {} });
  } finally {
    f.cleanup();
  }
});

test("equivalent explicit and implicit draft sandbox roots permit startup and resume", async () => {
  for (const shape of [
    "explicit",
    "implicit",
    "duplicate",
    "canonical-alias",
  ]) {
    const f = fixture({
      response: (result) => {
        const alias = path.join(result.cwd, "..", "one");
        result.sandbox.writableRoots =
          shape === "implicit"
            ? []
            : shape === "duplicate"
              ? [result.cwd, result.cwd]
              : shape === "canonical-alias"
                ? [alias]
                : [result.cwd];
        if (shape === "canonical-alias") result.runtimeWorkspaceRoots = [alias];
        return result;
      },
    });
    try {
      const first = await f.adapter.start({
        cwd: f.draft,
        prompt: "Document startup probe",
      });
      await f.adapter.interrupt(first.threadId);
      await f.adapter.resume(first.threadId);
      await f.adapter.send(first.threadId, "Follow-up probe");
      assert.equal(
        f.messages.filter((m) => m.method === "turn/start").length,
        2,
        shape,
      );
      for (const turn of f.messages.filter((m) => m.method === "turn/start")) {
        assert.deepEqual(turn.params.runtimeWorkspaceRoots, [f.draft]);
        assert.deepEqual(turn.params.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: [f.draft],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        });
      }
    } finally {
      f.cleanup();
    }
  }
});

test("broader or unverifiable sandboxes fail closed before startup and resumed turns", async () => {
  const cases: Record<string, (r: any) => void> = {
    "missing sandbox": (r) => {
      delete r.sandbox;
    },
    "full access": (r) => {
      r.sandbox = { type: "dangerFullAccess" };
    },
    "external sandbox": (r) => {
      r.sandbox = { type: "externalSandbox", networkAccess: "restricted" };
    },
    "unknown policy": (r) => {
      r.sandbox.type = "futureRestrictedPolicy";
    },
    "unknown permission field": (r) => {
      r.sandbox.extraWriteRoots = ["/"];
    },
    "network enabled": (r) => {
      r.sandbox.networkAccess = true;
    },
    "network missing": (r) => {
      delete r.sandbox.networkAccess;
    },
    "network wrong type": (r) => {
      r.sandbox.networkAccess = "false";
    },
    "runtime roots missing": (r) => {
      delete r.runtimeWorkspaceRoots;
    },
    "runtime roots empty": (r) => {
      r.runtimeWorkspaceRoots = [];
    },
    "runtime roots malformed": (r) => {
      r.runtimeWorkspaceRoots = r.cwd;
    },
    "runtime root broader": (r) => {
      r.runtimeWorkspaceRoots.push(path.dirname(r.cwd));
    },
    "runtime root unresolvable": (r) => {
      r.runtimeWorkspaceRoots.push(path.join(r.cwd, "missing"));
    },
    "runtime root relative": (r) => {
      r.runtimeWorkspaceRoots = ["."];
    },
    "cwd missing": (r) => {
      delete r.cwd;
    },
    "cwd broader": (r) => {
      r.cwd = path.dirname(r.cwd);
    },
    "thread cwd missing": (r) => {
      delete r.thread.cwd;
    },
    "thread cwd disagrees": (r) => {
      r.thread.cwd = path.dirname(r.cwd);
    },
    "approval policy broader": (r) => {
      r.approvalPolicy = "never";
    },
    "approval policy missing": (r) => {
      delete r.approvalPolicy;
    },
    "reviewer changed": (r) => {
      r.approvalsReviewer = "auto_review";
    },
    "reviewer missing": (r) => {
      delete r.approvalsReviewer;
    },
  };
  const writeCases: Record<string, (r: any) => void> = {
    "tmpdir enabled": (r) => {
      r.sandbox.excludeTmpdirEnvVar = false;
    },
    "tmpdir unverifiable": (r) => {
      delete r.sandbox.excludeTmpdirEnvVar;
    },
    "slash tmp enabled": (r) => {
      r.sandbox.excludeSlashTmp = false;
    },
    "slash tmp unverifiable": (r) => {
      delete r.sandbox.excludeSlashTmp;
    },
    "writable roots missing": (r) => {
      delete r.sandbox.writableRoots;
    },
    "writable roots malformed": (r) => {
      r.sandbox.writableRoots = {};
    },
    "write broader": (r) => {
      r.sandbox.writableRoots.push(path.dirname(r.cwd));
    },
    "write nonexistent": (r) => {
      r.sandbox.writableRoots.push(path.join(r.cwd, "missing"));
    },
    "write relative": (r) => {
      r.sandbox.writableRoots = ["."];
    },
    "write malformed path": (r) => {
      r.sandbox.writableRoots = [null];
    },
    "write symlink escape": (r) => {
      const link = path.join(r.cwd, "escape");
      if (!existsSync(link)) symlinkSync(path.dirname(r.cwd), link);
      r.sandbox.writableRoots = [link];
    },
  };
  for (const purpose of [undefined, "documents"] as const) {
    const mutations = purpose
      ? {
          ...cases,
          "unexpected writes": (r: any) => {
            r.sandbox.writableRoots = [r.cwd];
          },
        }
      : { ...cases, ...writeCases };
    for (const [name, mutate] of Object.entries(mutations)) {
      for (const resumed of [false, true]) {
        let reject = !resumed;
        const f = fixture({
          response: (result) => {
            const copy = structuredClone(result);
            if (reject) mutate(copy);
            return copy;
          },
        });
        try {
          let threadId: string | undefined;
          if (resumed) {
            ({ threadId } = await f.adapter.start({
              cwd: f.draft,
              prompt: "Initial",
              purpose,
            }));
            assert.equal(typeof threadId, "string");
            assert.ok(threadId);
            await f.adapter.interrupt(threadId);
            reject = true;
            await assert.rejects(
              f.adapter.resume(threadId),
              /sandbox|approvals/,
            );
          }
          const count = f.messages.filter(
            (m) => m.method === "turn/start",
          ).length;
          await assert.rejects(
            threadId
              ? f.adapter.send(threadId, "Must not run")
              : f.adapter.start({
                  cwd: f.draft,
                  prompt: "Must not run",
                  purpose,
                }),
            /sandbox|approvals/,
            `${name}, purpose=${purpose}, resumed=${resumed}`,
          );
          assert.equal(
            f.messages.filter((m) => m.method === "turn/start").length,
            count,
            name,
          );
        } finally {
          f.cleanup();
        }
      }
    }
  }
});

test("document tool startup and resume retain read-only network restrictions and scoped tools", async () => {
  const f = fixture();
  try {
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "Document probe",
      purpose: "documents",
    });
    const start = f.messages.find((m) => m.method === "thread/start").params;
    assert.deepEqual(
      start.dynamicTools.map((t: any) => t.name),
      ["read_job_search_source", "write_application_source"],
    );
    await f.adapter.interrupt(first.threadId);
    await f.adapter.resume(first.threadId);
    await f.adapter.send(first.threadId, "Follow-up probe");
    for (const request of f.messages.filter((m) =>
      ["thread/start", "thread/resume"].includes(m.method),
    )) {
      assert.equal(request.params.sandbox, "read-only");
      assert.equal(request.params.config.features.shell_tool, false);
      assert.equal(request.params.config.features.unified_exec, false);
      assert.equal(request.params.config.web_search, "disabled");
    }
    for (const turn of f.messages.filter((m) => m.method === "turn/start")) {
      assert.deepEqual(turn.params.sandboxPolicy, {
        type: "readOnly",
        networkAccess: false,
      });
    }
  } finally {
    f.cleanup();
  }
});

test("opening research gets hosted search and one structured save tool with the same restricted resume policy", async () => {
  const f = fixture();
  try {
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "Research the supplied opening",
      purpose: "opening-research",
    });
    const start = f.messages.find((m) => m.method === "thread/start").params;
    assert.deepEqual(
      start.dynamicTools.map((t: any) => t.name),
      [
        "read_job_search_source",
        "save_opening_research",
        "skip_greenhouse_opening",
      ],
    );
    await f.adapter.interrupt(first.threadId);
    await f.adapter.resume(first.threadId);
    await f.adapter.send(first.threadId, "Retry research");
    for (const request of f.messages.filter((m) =>
      ["thread/start", "thread/resume"].includes(m.method),
    )) {
      assert.equal(request.params.sandbox, "read-only");
      assert.equal(request.params.config.features.shell_tool, false);
      assert.equal(request.params.config.features.multi_agent, false);
      assert.equal(request.params.config.web_search, "live");
      assert.match(request.params.developerInstructions, /single job posting/);
    }
    for (const turn of f.messages.filter((m) => m.method === "turn/start"))
      assert.deepEqual(turn.params.sandboxPolicy, {
        type: "readOnly",
        networkAccess: false,
      });
  } finally {
    f.cleanup();
  }
});

test("protocol fixture: hidden reasoning and unrelated notifications do not reach application events", async () => {
  const f = fixture();
  try {
    const { threadId, turnId } = await f.adapter.start({
      cwd: f.draft,
      prompt: "Task",
    });
    f.notify("item/reasoning/textDelta", {
      threadId,
      delta: "SECRET_REASONING",
    });
    f.notify("item/completed", {
      threadId,
      turnId,
      item: { type: "reasoning", text: "SECRET_REASONING" },
    });
    f.notify("item/agentMessage/delta", {
      threadId: "unrelated",
      delta: "UNRELATED",
    });
    f.notify("item/agentMessage/delta", {
      threadId,
      turnId,
      delta: "Visible progress",
    });
    assert.equal(JSON.stringify(f.events).includes("SECRET_REASONING"), false);
    assert.equal(JSON.stringify(f.events).includes("UNRELATED"), false);
    assert.equal(JSON.stringify(f.events).includes("Visible progress"), true);
    assert.deepEqual(
      publicCodexValue({
        accessToken: "secret",
        turns: [
          {
            items: [
              { type: "reasoning", text: "hidden" },
              { type: "agentMessage", text: "okay" },
            ],
          },
        ],
      }),
      { turns: [{ items: [{ type: "agentMessage", text: "okay" }] }] },
    );
  } finally {
    f.cleanup();
  }
});

test("protocol fixture: disconnect preserves uncertain thread state and does not start another turn", async () => {
  const f = fixture();
  try {
    const { threadId } = await f.adapter.start({
      cwd: f.draft,
      prompt: "Task",
    });
    const count = f.messages.filter((m) => m.method === "turn/start").length;
    f.disconnect();
    assert.equal(f.adapter.status().threads[0].uncertain, true);
    assert.equal(f.adapter.status().available, false);
    await f.adapter.connect();
    await f.adapter.resume(threadId);
    assert.equal(
      f.messages.filter((m) => m.method === "turn/start").length,
      count,
    );
    await assert.rejects(
      f.adapter.send(threadId, "Do not duplicate"),
      /active turn/,
    );
  } finally {
    f.cleanup();
  }
});

test("protocol fixture: exact startup error is visible and one application controller owns threads", async () => {
  const f = fixture({
    startupError:
      "failed to initialize sqlite state runtime under /Users/example/.codex",
  });
  try {
    const result = await f.adapter.connect();
    assert.equal(result.available, false);
    assert.match(result.reason!, /failed to initialize sqlite state runtime/);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  const second = g.create();
  try {
    await g.adapter.connect();
    const status = await second.connect();
    assert.equal(status.available, false);
    assert.match(status.reason!, /Another application process controls/);
  } finally {
    second.close();
    g.cleanup();
  }
});

test("application-answer profile exposes only source reads and structured draft saves", async () => {
  const f = fixture();
  try {
    await f.adapter.start({
      cwd: f.draft,
      prompt: "Draft captured application answers",
      purpose: "application-answers",
    });
    const start = f.messages.find((m) => m.method === "thread/start").params;
    assert.deepEqual(
      start.dynamicTools.map((t: any) => t.name),
      ["read_job_search_source", "save_application_answers"],
    );
    assert.equal(start.config.model_reasoning_effort, "high");
    assert.equal(start.config.features.shell_tool, false);
    assert.equal(start.config.features.multi_agent, false);
    assert.equal(start.config.features.apps, false);
    assert.match(start.developerInstructions, /manualReviewRequired=true/);
    const turn = f.messages.find((m) => m.method === "turn/start").params;
    assert.deepEqual(turn.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    assert.equal(start.allowProviderModelFallback, false);
  } finally {
    f.cleanup();
  }
});

test("question profile keeps default/high and restricted reads across follow-up and resume", async () => {
  const f = fixture();
  try {
    const first = await f.adapter.start({
      cwd: f.draft,
      prompt: "Question",
      model: "gpt-6-astra",
      effort: "high",
      purpose: "questions",
    });
    const start = f.messages.find((m) => m.method === "thread/start");
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(start.params.config.features.shell_tool, false);
    assert.equal(start.params.config.features.unified_exec, false);
    assert.deepEqual(
      start.params.dynamicTools.map((t: any) => t.name),
      ["read_job_search_source"],
    );
    const turn = f.messages.find((m) => m.method === "turn/start");
    assert.equal(turn.params.model, "gpt-6-astra");
    assert.equal(turn.params.effort, "high");
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    await f.adapter.interrupt(first.threadId);
    await new Promise((r) => setTimeout(r, 0));
    await f.adapter.resume(first.threadId);
    const resumed = f.messages
      .filter((m) => m.method === "thread/resume")
      .at(-1);
    assert.equal(resumed.params.sandbox, "read-only");
    assert.equal(resumed.params.config.model_reasoning_effort, "high");
    await assert.rejects(
      f.adapter.readReferenceThread("unapproved-session"),
      /explicitly authorized/,
    );
  } finally {
    f.cleanup();
  }
});
