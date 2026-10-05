// Proves from esbuild's metafile that a bundle loads no OpenTelemetry module at startup (ADR-018):
// every path from the entry to an @opentelemetry module must cross a dynamic import(), which runs
// only when telemetry starts, and the SDK must still be in the bundle for when it does.
export function checkTelemetryIsLazy(metafile, entrySuffix) {
  const inputs = metafile.inputs;
  const entry = Object.keys(inputs).find((p) => p.endsWith(entrySuffix));
  if (!entry) throw new Error(`lazy telemetry check: no input ending ${entrySuffix}`);
  const eager = new Set();
  const stack = [entry];
  while (stack.length) {
    const path = stack.pop();
    if (eager.has(path)) continue;
    eager.add(path);
    for (const imp of inputs[path]?.imports ?? [])
      if (!imp.external && imp.kind !== "dynamic-import") stack.push(imp.path);
  }
  const otel = (p) => /(^|[\\/])@opentelemetry[\\/]/.test(p);
  const loadedAtStartup = [...eager].filter(otel);
  if (loadedAtStartup.length)
    throw new Error(
      `the bundle loads OpenTelemetry at startup; import it dynamically:\n  ${loadedAtStartup.slice(0, 10).join("\n  ")}`
    );
  if (!Object.keys(inputs).some(otel))
    throw new Error("the bundle has no OpenTelemetry SDK, so telemetry could never start");
}
