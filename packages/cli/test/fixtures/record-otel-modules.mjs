// Preloaded with `node --import`: records every module resolved from an @opentelemetry package or
// the ynr spool exporter, by import or require, and writes the list to $YNM_TEST_MODULES_OUT as
// the process exits. The proof that a process with telemetry off loads none of either.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const seen = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (
      specifier.startsWith("@opentelemetry/") ||
      specifier.startsWith("@eyelock/otel-spool-exporter") ||
      /[\\/](@opentelemetry|@eyelock[\\/]otel-spool-exporter)[\\/]/.test(resolved.url)
    )
      seen.add(resolved.url);
    return resolved;
  },
});
process.on("exit", () => {
  if (process.env.YNM_TEST_MODULES_OUT)
    writeFileSync(process.env.YNM_TEST_MODULES_OUT, JSON.stringify([...seen]));
});
