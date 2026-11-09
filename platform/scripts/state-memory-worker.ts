import { openFixtureWorkspace } from "../app/tests/fixtures/http-workspace.js";
import { GreenhousePullManager } from "../app/server/greenhouse-pull.js";
import { seedStateMemory } from "./state-memory-fixture.js";
import { measureExportHour } from "./state-memory-export-hour.js";
import { measurePullCycle } from "./state-memory-pull.js";
import { instrumentMemory } from "./state-memory-instrumentation.js";

export async function runMemoryWorker(root: string, hiddenMiB: number) {
  const workspace = await openFixtureWorkspace(root);
  const shape = seedStateMemory(workspace.store, hiddenMiB);
  // Drain startup export outside the measurement, then collect before each operation.
  workspace.store.flushExport();
  const manager = new GreenhousePullManager(workspace.store, {
    autoStart: false,
    notify() {},
    defaultModel: () => undefined,
    createResearch: async () => {
      throw Error("No model in memory fixture");
    },
    startTask: async () => {
      throw Error("No model in memory fixture");
    },
  });
  const memory = instrumentMemory(workspace.store);
  process.on("message", async (message: { operation: string }) => {
    try {
      if (message.operation === "begin") memory.begin();
      else if (message.operation === "end") {
        process.send?.({ type: "result", result: memory.end() });
        return;
      } else if (message.operation === "flush") workspace.store.flushExport();
      else if (message.operation === "auto-export") {
        workspace.store.autoExport();
        await new Promise((resolve) => setTimeout(resolve, 2100));
      } else if (message.operation === "ledger")
        manager.ledger("memory-ledger");
      else if (message.operation === "pull-state") manager.state();
      else if (message.operation === "pull-cycle") {
        const pull = await measurePullCycle(workspace.store);
        process.send?.({ type: "ack", pull });
        return;
      } else if (message.operation === "export-hour") {
        const pull = await measureExportHour(workspace.store);
        process.send?.({ type: "ack", pull });
        return;
      } else if (message.operation === "stop") {
        memory.close();
        await manager.close();
        await workspace.close();
        process.disconnect();
        return;
      }
      process.send?.({ type: "ack" });
    } catch (error) {
      process.send?.({ type: "error", error: String(error) });
    }
  });
  process.send?.({
    type: "ready",
    base: new URL((await workspace.get("/api/health")).url).origin,
    shape,
  });
}
