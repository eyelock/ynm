import { readFileSync } from "node:fs";
import { main } from "./index.js";
import { RELEASE_VERSION } from "./version.js";

it("the compiled-in version is ynm's release, the CLI's package version (run the build to regenerate)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8")
  ) as { version: string };
  expect(RELEASE_VERSION).toBe(pkg.version);
});

it("ynm-mcp --version prints ynm's release", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await main(["--version"]);
    expect(write).toHaveBeenCalledWith(`ynm-mcp ${RELEASE_VERSION}\n`);
  } finally {
    write.mockRestore();
  }
});
