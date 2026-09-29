// Regenerates the checked-in ynh plugin manifest and skill from the service (ADR-013).
import { writeFileSync, mkdirSync } from "node:fs";
import { ynhPlugin, ynhSkill } from "../packages/service/dist/clients/ynh.js";
import pkg from "../packages/cli/package.json" with { type: "json" };

const plugin = ynhPlugin({ version: pkg.version, transport: { kind: "stdio", command: "ynm-mcp", args: ["--stdio"] } });
mkdirSync(".ynh-plugin", { recursive: true });
writeFileSync(".ynh-plugin/plugin.json", `${JSON.stringify(plugin, null, 2)}\n`);
mkdirSync("skills/ynm-memory", { recursive: true });
writeFileSync("skills/ynm-memory/SKILL.md", ynhSkill());
console.log("wrote .ynh-plugin/plugin.json and skills/ynm-memory/SKILL.md");
