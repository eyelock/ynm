// Regenerates checked-in client artefacts from the service (ADR-013): the ynh plugin and skill,
// the Pi extension and skill.
import { mkdirSync, writeFileSync } from "node:fs";
import { piExtensionSource, piSkill } from "../packages/service/dist/clients/pi.js";
import { ynhPlugin, ynhSkill } from "../packages/service/dist/clients/ynh.js";
import pkg from "../packages/cli/package.json" with { type: "json" };

const plugin = ynhPlugin({ version: pkg.version, transport: { kind: "stdio", command: "ynm", args: ["serve"] } });
mkdirSync(".ynh-plugin", { recursive: true });
writeFileSync(".ynh-plugin/plugin.json", `${JSON.stringify(plugin, null, 2)}\n`);
mkdirSync("skills/ynm-memory", { recursive: true });
writeFileSync("skills/ynm-memory/SKILL.md", ynhSkill());
mkdirSync("clients/pi", { recursive: true });
writeFileSync("clients/pi/ynm.ts", piExtensionSource());
writeFileSync("clients/pi/SKILL.md", piSkill());
console.log("wrote .ynh-plugin/, skills/ynm-memory/, clients/pi/");
