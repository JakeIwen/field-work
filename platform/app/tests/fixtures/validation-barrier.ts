import { existsSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../server/storage.js";

/** Pause a real verifier after it passes, while its parent is still awaiting it. */
export function holdPdfValidation(directory: string) {
  atomicWrite(path.join(directory, "hold-validation"), "hold");
  let polling: ReturnType<typeof setInterval>;
  let timeout: ReturnType<typeof setTimeout>;
  const started = new Promise<void>((resolve, reject) => {
    polling = setInterval(() => {
      if (!existsSync(path.join(directory, "validation-started"))) return;
      clearInterval(polling);
      clearTimeout(timeout);
      resolve();
    }, 10);
    // Concurrent suite fixtures compile and run Swift before reaching this barrier.
    timeout = setTimeout(() => {
      clearInterval(polling);
      reject(
        new Error("Native validation did not reach its publication barrier"),
      );
    }, 60000);
  });
  return {
    started,
    release() {
      clearInterval(polling);
      clearTimeout(timeout);
      atomicWrite(path.join(directory, "validation-release"), "release");
    },
  };
}
