import { startDemo } from "./demo-runtime.js";
const demo = await startDemo(process.argv.slice(2));
console.log(`Demo: ${demo.url}`);
console.log(`Synthetic data: ${demo.layout.home}`);
console.log(`Outbound attempts: ${demo.logFile}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void demo.close().then(() => process.exit(0)));
