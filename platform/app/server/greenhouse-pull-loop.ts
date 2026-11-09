import { diagnosticLog } from "./diagnostic-log.js";
import { tunables } from "../shared/tunables.js";

export class GreenhousePullLoop {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;

  constructor(
    private step: () => Promise<boolean | void>,
    autoStart: boolean,
    private intervalMs: () => number = () =>
      tunables["greenhouse.loopIntervalMs"].default,
    private burstSteps: () => number = () =>
      tunables["greenhouse.burstSteps"].default,
  ) {
    if (autoStart) this.schedule();
  }

  private schedule() {
    const interval = this.intervalMs();
    this.timer = setInterval(() => {
      this.wake();
      if (!this.stopped && this.intervalMs() !== interval) {
        clearInterval(this.timer);
        this.schedule();
      }
    }, interval);
    this.timer.unref();
  }

  wake() {
    if (this.stopped || this.pending) return;
    this.pending = this.drain()
      .catch((error) => {
        diagnosticLog(
          "error",
          "greenhouse-pull",
          "Greenhouse pull tick failed:",
          {},
          error,
        );
      })
      .finally(() => {
        this.pending = undefined;
      });
  }

  private async drain() {
    // A broken/no-progress action must yield rather than monopolizing the loop.
    const maximumStepsPerWake = this.burstSteps();
    for (let step = 0; step < maximumStepsPerWake && !this.stopped; step++) {
      if (!(await this.step())) return;
    }
  }

  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
