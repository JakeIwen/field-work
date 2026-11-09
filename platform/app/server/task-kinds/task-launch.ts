import { HttpError } from "../storage.js";

/** Another task is launching; this one is saved and can start afterward. */
export class TaskLaunchBusy extends HttpError {
  constructor() {
    super(
      409,
      "Another task is starting. This saved task remains available to start afterward.",
    );
  }
}
