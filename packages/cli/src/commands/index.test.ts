import { readdirSync } from "node:fs";
import { COMMANDS } from "./index.js";

describe("explicit command map", () => {
  it("lists every command file in the directory, each under its file name", async () => {
    const files = readdirSync(import.meta.dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(Object.keys(COMMANDS).sort()).toEqual(files);
    for (const id of files) {
      const mod = (await import(`./${id}.js`)) as { default: unknown };
      expect(COMMANDS[id as keyof typeof COMMANDS], id).toBe(mod.default);
    }
  });
});
