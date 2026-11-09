import { registerModelSettingsRoutes } from "./routes/model-settings.js";
import { createCloudIngress } from "./cloud-ingress.js";
import { register as registerApplications } from "./routes/applications.js";
import { register as registerDocuments } from "./routes/documents.js";
import { register as registerGreenhouse } from "./routes/greenhouse.js";
import { register as registerOpenings } from "./routes/openings.js";
import { register as registerSystem } from "./routes/system.js";
import { register as registerTasks } from "./routes/tasks.js";
import { register as registerDeletion } from "./routes/deletion.js";
import { register as registerRecords } from "./routes/records.js";
import { register as registerGmail } from "./routes/gmail.js";
import { register as registerFollowUp } from "./routes/follow-up.js";
import {
  WorkspaceRuntime,
  type WorkspaceOptions,
} from "./task-kinds/workspace-runtime.js";

export type WorkspaceContext = WorkspaceRuntime;

export async function createWorkspace(options: WorkspaceOptions) {
  const ctx = new WorkspaceRuntime(options);
  ctx.initializeCareers();
  ctx.initializeOpeningValidation();
  ctx.initializeScheduler();
  await ctx.reindex();
  ctx.recoverInterruptedRenders();
  ctx.recoverInterruptedAutofill();
  ctx.recoverBusyTasks();
  ctx.recoverInterruptedSends();
  ctx.initializeAgent();
  ctx.connectAgent();

  if (options.cloudAccess) {
    if (!options.machineToken)
      throw new Error("Cloud machine token is required");
    ctx.app.use(createCloudIngress(options.cloudAccess, options.machineToken));
  }
  registerSystem(ctx.app, ctx, "initial");
  registerGmail(ctx.app, ctx);
  registerSystem(ctx.app, ctx, "personal");
  registerApplications(ctx.app, ctx);
  registerFollowUp(ctx.app, ctx);
  registerDocuments(ctx.app, ctx, "documents");
  registerSystem(ctx.app, ctx, "settings");
  registerModelSettingsRoutes(ctx.app, ctx);
  registerDocuments(ctx.app, ctx, "reports");
  registerSystem(ctx.app, ctx, "preferences");
  registerTasks(ctx.app, ctx, "status");
  registerTasks(ctx.app, ctx, "questions");
  registerTasks(ctx.app, ctx, "connect");

  ctx.initializeGreenhousePull();
  registerGreenhouse(ctx.app, ctx, "start");
  registerGreenhouse(ctx.app, ctx, "control");
  registerTasks(ctx.app, ctx, "create");
  registerOpenings(ctx.app, ctx, "opening");

  ctx.initializePreparation();
  registerOpenings(ctx.app, ctx, "preparation");
  registerTasks(ctx.app, ctx, "start");
  registerTasks(ctx.app, ctx, "details");
  registerRecords(ctx.app, ctx);
  registerDeletion(ctx.app, ctx);
  registerSystem(ctx.app, ctx, "client");

  if (options.background !== false) ctx.startScheduler();
  ctx.startWatcher();
  return {
    app: ctx.app,
    store: ctx.store,
    agent: ctx.agent,
    reindex: ctx.reindex,
    close: async () => {
      await ctx.close();
    },
  };
}
