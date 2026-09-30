import { readFileSync } from "node:fs";
import { MCP_VERSION } from "./version.js";

it("the compiled-in version matches package.json (run the build to regenerate)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(MCP_VERSION).toBe(pkg.version);
});
