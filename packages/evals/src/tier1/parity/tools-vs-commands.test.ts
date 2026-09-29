import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TOOL_SPECS } from "@ynm/service";
import { z } from "zod";

const cliDist = join(import.meta.dirname, "..", "..", "..", "..", "cli", "dist", "commands");
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** ADR-008: every MCP tool has a CLI command exposing the same input fields. */
describe("tier1 parity: tools vs commands", () => {
  for (const spec of TOOL_SPECS) {
    it(`${spec.name} ↔ ynm ${spec.command}`, async () => {
      const file = join(cliDist, `${spec.command}.js`);
      expect(existsSync(file), `missing command file for ${spec.command}`).toBe(true);
      const mod = (await import(pathToFileURL(file).href)) as {
        default: { flags?: Record<string, unknown>; args?: Record<string, unknown> };
      };
      const flags = Object.keys(mod.default.flags ?? {});
      const args = Object.keys(mod.default.args ?? {});
      const props = Object.keys(
        (
          z.toJSONSchema(spec.input, { io: "input", unrepresentable: "any" }) as {
            properties?: Record<string, unknown>;
          }
        ).properties ?? {}
      );
      for (const p of props)
        expect([...flags, ...args], `${spec.command} lacks ${p}`).toContain(
          flags.includes(kebab(p)) ? kebab(p) : args.includes(p) ? p : kebab(p)
        );
    });
  }
});
