import type { Task } from "../shared/types.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { unzipSync, strFromU8 } from "fflate";
import { messageSelection } from "../shared/model-selection.js";
import { contextTool } from "../server/context-tools.js";
import { messageModelWorkspace } from "./fixtures/message-model-workspace.js";

const starts = (f: Awaited<ReturnType<typeof messageModelWorkspace>>) =>
  f.codex.messages.filter((message) => message.method === "turn/start");

test("message choices reach the same Codex thread and do not pin the following default", async () => {
  const f = await messageModelWorkspace();
  try {
    const settings = f.store.settings();
    f.store.put("settings", "main", {
      ...settings,
      codexEfforts: { questions: "xhigh" },
    });
    const first = await f.create("gpt-6-sol");
    assert.equal(starts(f).at(-1).params.model, "gpt-6-sol");
    assert.equal(
      starts(f).at(-1).params.effort,
      "high",
      "unsupported saved effort falls back to High",
    );
    await f.complete(first, "First answer");
    const send = (body: object) =>
      f.post(`/api/tasks/${first.id}/message`, body);
    assert.equal(
      (await send({ prompt: "Untouched picker", clientRequestId: "default" }))
        .status,
      200,
    );
    assert.equal(starts(f).at(-1).params.model, "gpt-6-astra");
    assert.equal(starts(f).at(-1).params.effort, "xhigh");
    await f.complete(f.saved(first.id), "Default answer");
    assert.equal(
      (
        await send({
          prompt: "Use Sol",
          model: "gpt-6-sol",
          clientRequestId: "selected",
        })
      ).status,
      200,
    );
    assert.equal(starts(f).at(-1).params.model, "gpt-6-sol");
    assert.equal(f.saved(first.id).threadId, first.threadId);
    assert.equal(f.saved(first.id).previousThreadIds, undefined);
    assert.deepEqual(
      messageSelection(f.saved(first.id), f.saved(first.id).messages.at(-1)!),
      { model: "gpt-6-sol", effort: "high" },
    );
    const before = starts(f).length;
    assert.equal(
      (
        await send({
          prompt: "Use Sol",
          model: "gpt-6-sol",
          clientRequestId: "selected",
        })
      ).status,
      200,
    );
    assert.equal(
      starts(f).length,
      before,
      "request retry starts no extra turn",
    );
  } finally {
    await f.close();
  }
});

test("unavailable or malformed message models reject before creating any turn", async () => {
  const f = await messageModelWorkspace();
  try {
    for (const model of ["not-a-model", "gpt-5.6", "", null, 123]) {
      const response = await f.post("/api/tasks", {
        preset: "questions",
        prompt: "No",
        model,
        mode: "live",
      });
      assert.equal(response.status, 400);
    }
    assert.equal(f.store.list("task").length, 0);
    assert.equal(starts(f).length, 0);
    const first = await f.create();
    await f.complete(first, "Before failed choice");
    const response = await f.post(`/api/tasks/${first.id}/message`, {
      prompt: "No",
      model: "missing-model",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /unavailable.*no substitute/i);
    assert.equal(starts(f).length, 1);
    assert.equal(f.saved(first.id).messages.length, 2);
  } finally {
    await f.close();
  }
});

test("cross-provider messages keep ordered text, captured sources, attribution, old threads and backups", async () => {
  const f = await messageModelWorkspace();
  try {
    const first = await f.create();
    await f.complete(first, "Earlier Codex answer");
    const original = f.saved(first.id);
    const source = "source_data/github_evidence_dossier.md";
    writeFileSync(
      path.join(f.codex.root, source),
      "Changed authoritative evidence after capture",
    );
    const response = await f.post(`/api/tasks/${first.id}/message`, {
      prompt: "Continue with Claude",
      model: "claude-opus-5-5",
      clientRequestId: "carry",
    });
    assert.equal(response.status, 200, await response.clone().text());
    await setImmediate();
    const carried = f.saved(first.id);
    assert.notEqual(carried.threadId, first.threadId);
    assert.deepEqual(carried.previousThreadIds, [first.threadId]);
    assertCarriedSnapshot(f, first, original, carried, source);
    await assertHistoricalMessages(f, first, carried);
    const back = await f.post(`/api/tasks/${first.id}/message`, {
      prompt: "Back to Codex",
      model: "gpt-6-sol",
      clientRequestId: "back",
    });
    assert.equal(back.status, 200, await back.clone().text());
    const returned = f.saved(first.id);
    assert.deepEqual(returned.previousThreadIds, [
      first.threadId,
      carried.threadId,
    ]);
    assert.equal(starts(f).at(-1).params.model, "gpt-6-sol");
    assert.match(starts(f).at(-1).params.input[0].text, /Continue with Claude/);
    assert.ok(
      starts(f).at(-1).params.input[0].text.includes(carried.messages[3].text),
    );
    const files = unzipSync(f.store.backup());
    assert.ok(files["codex-threads.json"]);
    assert.ok(files["claude-threads.json"]);
    assert.ok(
      strFromU8(files["personal-export.json"]).includes(carried.threadId!),
    );
    assert.ok(
      strFromU8(files["personal-export.json"]).includes("Earlier Codex answer"),
    );
    await f.agent.resume(first.threadId!);
    assert.equal(
      f.saved(first.id).threadId,
      returned.threadId,
      "old thread read/resume events cannot replace the current owner",
    );
  } finally {
    await f.close();
  }
});

test("same-provider Claude follow-up chooses a model for that turn only", async () => {
  const f = await messageModelWorkspace();
  try {
    const settings = f.store.settings();
    f.store.put("settings", "main", {
      ...settings,
      codexModels: { questions: "claude-opus-5-5" },
      codexEfforts: { questions: "xhigh" },
    });
    const first = await f.create();
    const response = await f.post(`/api/tasks/${first.id}/message`, {
      prompt: "Use Fable once",
      model: "claude-fable-5-1",
    });
    assert.equal(response.status, 200);
    await setImmediate();
    assert.equal(f.claude.sessions[1].options.model, "claude-fable-5-1[1m]");
    assert.equal(f.claude.sessions[1].options.effort, "xhigh");
    assert.equal(f.claude.sessions[1].options.resume, first.threadId);
    assert.equal(
      (
        await f.post(`/api/tasks/${first.id}/message`, {
          prompt: "Use saved default",
        })
      ).status,
      200,
    );
    assert.equal(f.claude.sessions[2].options.model, "claude-opus-5-5[1m]");
    assert.equal(f.claude.sessions[2].options.resume, first.threadId);
  } finally {
    await f.close();
  }
});

function assertCarriedSnapshot(
  f: Awaited<ReturnType<typeof messageModelWorkspace>>,
  first: Task,
  original: Task,
  carried: Task,
  source: string,
) {
  assert.equal(f.claude.sessions[0].options.model, "claude-opus-5-5[1m]");
  assert.equal(
    f.claude.sessions[0].options.cwd,
    path.join(f.codex.dataDir, "drafts", first.id),
  );
  const seed = String(f.claude.sessions[0].prompts[0].message.content);
  assert.match(seed, /context-manifest.json/);
  assert.match(seed, /job-posting.txt/);
  assert.ok(
    seed.indexOf('"text":"First question"') <
      seed.indexOf('"text":"Earlier Codex answer"'),
  );
  assert.ok(
    seed.indexOf('"text":"Earlier Codex answer"') <
      seed.indexOf("New user message:\n\nContinue with Claude"),
  );
  assert.match(seed, /Earlier tool calls and tool outputs are not included/);
  assert.deepEqual(carried.manifest, original.manifest);
  assert.deepEqual(carried.posting, original.posting);
  assert.equal(
    contextTool(f.store, carried.threadId!, "read_job_search_source", {
      path: source,
    }).text,
    readFileSync(
      path.join(f.codex.dataDir, "drafts", first.id, source),
      "utf8",
    ),
  );
  assert.match(
    contextTool(f.store, carried.threadId!, "read_job_search_source", {
      path: source,
    }).text,
    /Captured fixture evidence/,
  );
  assert.throws(
    () =>
      contextTool(f.store, first.threadId!, "read_job_search_source", {
        path: source,
      }),
    /no question\/document source tools/,
  );
}

async function assertHistoricalMessages(
  f: Awaited<ReturnType<typeof messageModelWorkspace>>,
  first: Task,
  carried: Task,
) {
  assert.equal(f.store.taskForThread(first.threadId)?.id, first.id);
  const old = await f.get(`/api/tasks/${first.id}/threads/${first.threadId}`);
  assert.equal(old.status, 200);
  assert.equal(
    (await old.json()).thread.turns[0].items[0].text,
    "Earlier Codex answer",
  );
  assert.equal(
    (await f.get(`/api/tasks/${first.id}/threads/not-owned`)).status,
    404,
  );
  assert.equal(
    messageSelection(carried, carried.messages[1])?.model,
    "gpt-6-astra",
  );
  assert.equal(
    messageSelection(carried, carried.messages[2])?.model,
    "claude-opus-5-5",
  );
  assert.equal(
    messageSelection(carried, carried.messages[3])?.model,
    "claude-opus-5-5",
  );
}
