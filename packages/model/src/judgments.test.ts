import { z } from "zod";
import { DreamConfigSchema } from "./judgments.js";
import { MemoryRecordSchema } from "./record.js";

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
};

function undescribed(schema: JsonSchema, prefix = ""): string[] {
  const out: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!prop.description) out.push(`${prefix}${name}`);
    out.push(...undescribed(prop, `${prefix}${name}.`));
  }
  return out;
}

describe("schema descriptions feed CLI, MCP and docs", () => {
  it("every dream config key has a description", () => {
    const json = z.toJSONSchema(DreamConfigSchema, { io: "input" }) as JsonSchema;
    expect(undescribed(json)).toEqual([]);
  });
  it("op, tags and links on a record have descriptions", () => {
    const json = z.toJSONSchema(MemoryRecordSchema, { io: "input" }) as JsonSchema;
    for (const key of ["op", "tags", "links"]) {
      expect(json.properties?.[key]?.description, key).toBeTruthy();
    }
  });
});
