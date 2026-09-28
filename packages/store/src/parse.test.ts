import { ulid } from "@ynm/model";
import { parseJsonl, serializeJsonl } from "./parse.js";

const id = ulid();
const good = {
  v: 1,
  id,
  memoryId: id,
  op: "create",
  type: "semantic",
  level: "personal",
  namespace: "common",
  content: "x",
  recordedAt: "2026-09-29T00:00:00.000Z",
  provenance: { actor: "t" },
};

describe("parseJsonl (NFR-7)", () => {
  it("skips and reports a corrupt line, keeping the rest", () => {
    const text = `${JSON.stringify(good)}\n{not json\n${JSON.stringify({ ...good, id: ulid(), memoryId: undefined })}\n`;
    const { records, problems } = parseJsonl(text);
    expect(records).toHaveLength(1);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ line: 2 });
    expect(problems[0]?.message).toMatch(/invalid JSON/);
  });
  it("reports unknown schema versions", () => {
    const { records, problems } = parseJsonl(`${JSON.stringify({ ...good, v: 99 })}\n`);
    expect(records).toHaveLength(0);
    expect(problems[0]?.message).toMatch(/unknown schema version 99/);
  });
  it("collapses duplicate ids", () => {
    const { records } = parseJsonl(`${JSON.stringify(good)}\n${JSON.stringify(good)}\n`);
    expect(records).toHaveLength(1);
  });
  it("round-trips through serializeJsonl with a trailing newline", () => {
    const { records } = parseJsonl(serializeJsonl(parseJsonl(`${JSON.stringify(good)}\n`).records));
    expect(records[0]?.id).toBe(id);
    expect(serializeJsonl(records).endsWith("\n")).toBe(true);
    expect(serializeJsonl([])).toBe("");
  });
});
