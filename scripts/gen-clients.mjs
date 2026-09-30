// Regenerates checked-in client artefacts from the service (ADR-013): the ynh plugin and skill,
// the Pi extension and skill.
import { mkdirSync, writeFileSync } from "node:fs";
import { piExtensionSource } from "../packages/service/dist/clients/pi.js";
import { ynmSkill } from "../packages/service/dist/clients/skill.js";
import { ynhPlugin } from "../packages/service/dist/clients/ynh.js";
import pkg from "../packages/cli/package.json" with { type: "json" };

const plugin = ynhPlugin({ version: pkg.version, transport: { kind: "stdio", command: "ynm", args: ["serve"] } });
mkdirSync("integrations/ynh/.ynh-plugin", { recursive: true });
writeFileSync("integrations/ynh/.ynh-plugin/plugin.json", `${JSON.stringify(plugin, null, 2)}\n`);
mkdirSync("integrations/skills/ynm-memory", { recursive: true });
writeFileSync("integrations/skills/ynm-memory/SKILL.md", ynmSkill());
mkdirSync("integrations/pi", { recursive: true });
writeFileSync("integrations/pi/ynm.ts", piExtensionSource());
console.log("wrote integrations/skills/, integrations/ynh/ and integrations/pi/");
