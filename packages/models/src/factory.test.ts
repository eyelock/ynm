import { resolveModels } from "./factory.js";
import { ModelUnavailableError } from "./types.js";

describe("resolveModels writer selection", () => {
  it("configured claude-cli and openai-compatible writers report why", () => {
    const cli = resolveModels(
      { judge: "heuristic", writer: "claude-cli", claude: { model: "m" } },
      {}
    );
    expect(cli.writer.name).toBe("claude-cli");
    expect(cli.resolution.writer).toBe("configured claude-cli");
    const oa = resolveModels(
      {
        judge: "heuristic",
        writer: "openai-compatible",
        openai: { baseUrl: "http://gpu:8000/v1" },
      },
      {}
    );
    expect(oa.resolution.writer).toBe("configured openai-compatible (http://gpu:8000/v1)");
    expect(resolveModels({ judge: "heuristic", writer: "none" }, {}).resolution.writer).toBe(
      "configured none"
    );
  });

  it("auto picks openai-compatible when a key or base URL env is present", () => {
    const withKey = resolveModels(undefined, { OPENAI_API_KEY: "fake-key" });
    expect(withKey.writer.name).toBe("openai-compatible");
    expect(withKey.resolution.writer).toBe("auto: openai-compatible endpoint configured");
    expect(withKey.judge.name).toBe("writer-emulated:openai-compatible");
    expect(withKey.resolution.judge).toBe("auto: emulated over openai-compatible (uncalibrated)");
    const withUrl = resolveModels(undefined, {
      YNM_OPENAI_BASE_URL: "http://box/v1",
      YNM_OPENAI_MODEL: "llama",
    });
    expect(withUrl.writer.name).toBe("openai-compatible");
  });

  it("auto prefers the claude CLI probe over an openai key", () => {
    const r = resolveModels(undefined, { OPENAI_API_KEY: "fake-key" }, { claudeCli: true });
    expect(r.writer.name).toBe("claude-cli");
    expect(r.resolution.writer).toBe("auto: claude CLI available");
  });

  it("auto with nothing available says so", () => {
    const r = resolveModels(undefined, {});
    expect(r.resolution).toEqual({
      judge: "auto: no model available",
      writer: "auto: no writer available",
    });
  });

  it("an empty key variable name disables key lookup for both seams", () => {
    const r = resolveModels(
      { judge: "auto", writer: "auto", typesafe: { apiKeyEnv: "" }, openai: { apiKeyEnv: "" } },
      { "": "fake-key", TYPESAFE_API_KEY: "fake-key", OPENAI_API_KEY: "fake-key" }
    );
    expect(r.writer.name).toBe("none");
    expect(r.judge.name).toBe("heuristic");
  });
});

describe("resolveModels judge selection", () => {
  it("configured typesafe uses the key, and fails without one", () => {
    const r = resolveModels(
      { judge: "typesafe", writer: "none" },
      { TYPESAFE_API_KEY: "fake-key" }
    );
    expect(r.judge.name).toBe("typesafe");
    expect(r.resolution.judge).toBe("configured typesafe");
    expect(() => resolveModels({ judge: "typesafe", writer: "none" }, {})).toThrow(
      ModelUnavailableError
    );
  });

  it("configured writer-emulated and heuristic report why", () => {
    const em = resolveModels({ judge: "writer-emulated", writer: "claude-cli" }, {});
    expect(em.judge.name).toBe("writer-emulated:claude-cli");
    expect(em.resolution.judge).toBe("configured writer-emulated over claude-cli");
    const h = resolveModels(
      { judge: "heuristic", writer: "none" },
      { TYPESAFE_API_KEY: "fake-key" }
    );
    expect(h.judge.name).toBe("heuristic");
    expect(h.resolution.judge).toBe("configured heuristic");
  });

  it("reads process.env by default", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "fake-key");
    try {
      expect(resolveModels().judge.name).toBe("typesafe");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
