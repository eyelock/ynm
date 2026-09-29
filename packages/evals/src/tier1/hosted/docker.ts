import { spawnSync } from "node:child_process";

/** Docker helpers for the hosted integration tests; everything skips when the daemon is absent. */
export function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0;
}

export function docker(...args: string[]): string {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900_000,
  });
  if (r.status !== 0)
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Host port mapped to `containerPort` on a running container. */
export function hostPort(container: string, containerPort: number): number {
  const out = docker("port", container, String(containerPort));
  const m = /:(\d+)\s*$/m.exec(out);
  if (!m) throw new Error(`no host port for ${containerPort}: ${out}`);
  return Number(m[1]);
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}
