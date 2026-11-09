import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deployPreview,
  publishPreview,
} from "../scripts/preview-deployment.js";
import {
  currentPreview,
  previewDirectory,
} from "../server/companion-preview.js";

function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "preview-deploy-"));
  const build = (stage: string, content: string) => {
    mkdirSync(path.join(stage, "assets"), { recursive: true });
    writeFileSync(path.join(stage, "index.html"), content);
    writeFileSync(path.join(stage, `assets/${content}.js`), content);
  };
  const first = path.join(dataDir, "first");
  build(first, "old");
  publishPreview(dataDir, first);
  const calls: string[][] = [];
  const messages: string[] = [];
  let time = 0;
  const control = {
    dataDir,
    restart: true,
    command: (args: string[]) => {
      calls.push(args);
      if (args[1] === "build") build(args.at(-1) ?? "", "new");
    },
    read: async (route: string): Promise<unknown> =>
      route === "/api/system/activity"
        ? { remaining: [] }
        : { status: "ok", connected: true },
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    report: (message: string) => {
      messages.push(message);
    },
  };
  return {
    control,
    calls,
    messages,
    content: () =>
      readFileSync(
        path.join(currentPreview(previewDirectory(dataDir)), "index.html"),
        "utf8",
      ),
    close: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("preview builds separately, waits for live inventory, then only restarts companion", async () => {
  const f = fixture();
  let probes = 0;
  f.control.read = async (route) => {
    if (route === "/api/system/activity") {
      probes++;
      assert.equal(f.content(), "old");
      assert(!f.calls.some((args) => args[1] === "service:restart"));
      return { remaining: probes === 1 ? [{ kind: "render" }] : [] };
    }
    return { status: "ok", connected: true };
  };
  try {
    await deployPreview(f.control);
    assert.deepEqual(
      f.calls.map((args) => args[1]),
      ["service:status", "build", "service:restart"],
    );
    assert.equal(probes, 2);
    assert.equal(f.content(), "new");
    assert(f.messages.some((message) => message.startsWith("Waiting")));
    assert(
      !existsSync(
        path.join(previewDirectory(f.control.dataDir), "deployment.lock"),
      ),
    );
  } finally {
    f.close();
  }
});

test("failed build and missing output preserve last good preview without restarting", async () => {
  for (const failure of ["build", "missing"]) {
    const f = fixture();
    f.control.command = (args) => {
      f.calls.push(args);
      if (args[1] === "build" && failure === "build")
        throw new Error("build failed");
    };
    try {
      await assert.rejects(deployPreview(f.control));
      assert.equal(f.content(), "old");
      assert(!f.calls.some((args) => args[1] === "service:restart"));
    } finally {
      f.close();
    }
  }
});

test("busy, reloading and unverifiable inventory never activate or restart", async () => {
  for (const state of ["busy", "reloading", "malformed", "disconnected"]) {
    const f = fixture();
    f.control.sleep = async () => {
      f.control.now = () => 1_000_000;
    };
    f.control.read = async (route) => {
      if (route === "/api/system/activity")
        return state === "malformed"
          ? {}
          : { remaining: state === "busy" ? [{}] : [] };
      return {
        status: "ok",
        reloading: state === "reloading",
        connected: state !== "disconnected",
      };
    };
    try {
      await assert.rejects(deployPreview(f.control), /did not become idle/);
      assert.equal(f.content(), "old");
      assert(!f.calls.some((args) => args[1] === "service:restart"));
    } finally {
      f.close();
    }
  }
});

test("a failed status check keeps waiting and publishes once Fieldwork is idle", async () => {
  const f = fixture();
  let failures = 3;
  const idle = f.control.read;
  f.control.read = async (route) => {
    if (route === "/api/health" && failures-- > 0)
      throw new Error("The operation was aborted due to timeout");
    return idle(route);
  };
  try {
    await deployPreview(f.control);
    assert.equal(f.content(), "new");
    assert(
      f.messages.some((message) =>
        message.includes(
          "Status check failed (The operation was aborted due to timeout)",
        ),
      ),
    );
  } finally {
    f.close();
  }
});

test("status checks that never answer stop at the deadline without activating", async () => {
  const f = fixture();
  f.control.read = async () => {
    throw new Error("The operation was aborted due to timeout");
  };
  try {
    await assert.rejects(
      deployPreview(f.control),
      /did not become idle \(last status check failed: The operation was aborted due to timeout\)/,
    );
    assert.equal(f.content(), "old");
    assert(!f.calls.some((args) => args[1] === "service:restart"));
  } finally {
    f.close();
  }
});

test("restart waits for tunnel recovery and rolls back on exhausted recovery", async () => {
  for (const recover of [true, false]) {
    const f = fixture();
    let probes = 0;
    const read = f.control.read;
    f.control.read = async (route) => {
      if (
        route === "/api/companion/health" &&
        f.calls.some((args) => args[1] === "service:restart")
      ) {
        probes++;
        if (probes === 1) throw new Error("tunnel starting");
        return { status: "ok", connected: recover && probes > 2 };
      }
      return read(route);
    };
    try {
      if (recover) {
        await deployPreview(f.control);
        assert.equal(f.content(), "new");
        assert.equal(probes, 3);
      } else {
        await assert.rejects(
          deployPreview(f.control),
          /did not report a connected tunnel/,
        );
        assert.equal(f.content(), "old");
      }
    } finally {
      f.close();
    }
  }
});

test("failed restart restores the prior published preview", async () => {
  const f = fixture();
  const command = f.control.command;
  f.control.command = (args) => {
    if (args[1] === "service:restart") throw new Error("restart failed");
    command(args);
  };
  try {
    await assert.rejects(deployPreview(f.control), /restart failed/);
    assert.equal(f.content(), "old");
  } finally {
    f.close();
  }
});

test("default publish verifies the companion without restarting it", async () => {
  const f = fixture();
  f.control.restart = false;
  try {
    await deployPreview(f.control);
    assert.deepEqual(
      f.calls.map((args) => args[1]),
      ["service:status", "build"],
    );
    assert.equal(f.content(), "new");
    assert(f.messages.some((message) => message.includes("not restarted")));
  } finally {
    f.close();
  }
});

test("default publish rolls back when the companion stops answering", async () => {
  const f = fixture();
  f.control.restart = false;
  const read = f.control.read;
  f.control.read = async (route) => {
    if (route === "/api/companion/health" && f.content() === "new")
      return { status: "ok", connected: false };
    return read(route);
  };
  try {
    await assert.rejects(deployPreview(f.control), /connected tunnel/);
    assert.equal(f.content(), "old");
  } finally {
    f.close();
  }
});
