import { MCP_TOOLS } from "./index.js";

describe("@ynm/mcp", () => {
  it("declares the ten tools from ADR-008", () => {
    expect(MCP_TOOLS).toHaveLength(10);
  });
});
