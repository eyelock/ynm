import {
  AnnotateInputSchema,
  ContextQuerySchema,
  ForgetInputSchema,
  RecallQuerySchema,
  RememberInputSchema,
} from "@ynm/model";
import { z } from "zod";
import { flagsFromSchema, InvalidInputError, inputFromFlags, toKebab } from "./flags.js";

describe("flags from Zod (ADR-008)", () => {
  it("generates a flag per field with kebab names and enum options", () => {
    const flags = flagsFromSchema(RememberInputSchema);
    expect(Object.keys(flags)).toContain("data-schema");
    expect((flags.type as { options?: string[] }).options).toContain("episodic");
    expect((flags.content as { required?: boolean }).required).toBe(true);
    expect((flags.level as { required?: boolean }).required).toBeFalsy();
    expect((flags.tags as { multiple?: boolean }).multiple).toBe(true);
  });
  it("parses flags back, including JSON objects and numbers", () => {
    const input = inputFromFlags(RememberInputSchema, {
      type: "semantic",
      content: "x",
      data: '{"a":1}',
      importance: "0.7",
      tags: ["t1", "t2"],
      "data-schema": "profile/1",
      links: '[{"rel":"about","to":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}]',
    });
    expect(input.data).toEqual({ a: 1 });
    expect(input.importance).toBe(0.7);
    expect(input.dataSchema).toBe("profile/1");
    expect(input.links[0]?.rel).toBe("about");
    expect(input.level).toBe("personal");
  });
  it("splits comma-separated string-array values and says so in the description", () => {
    const flags = flagsFromSchema(RememberInputSchema);
    expect((flags.tags as { description?: string }).description).toContain(
      "repeat the flag or separate with commas"
    );
    const input = inputFromFlags(RememberInputSchema, {
      type: "semantic",
      content: "x",
      tags: ["a,b", "c"],
    });
    expect(input.tags).toEqual(["a", "b", "c"]);
  });
  it("reports malformed JSON as an InvalidInputError, not a SyntaxError", () => {
    expect(() =>
      inputFromFlags(RememberInputSchema, { type: "semantic", content: "x", data: "{bad" })
    ).toThrow(InvalidInputError);
  });
  it("shows schema defaults in the description and does not repeat the JSON suffix", () => {
    const flags = flagsFromSchema(RememberInputSchema);
    const d = (name: string) => (flags[name] as { description?: string }).description;
    expect(d("importance")).toBe("0..1 (number) (default: 0.5)");
    expect(d("namespace")).toContain("(default: common)");
    expect(d("data")).toBe("Structured payload (JSON object)");
    expect(d("tags")).not.toContain("default");
  });
  it("gives the flags that were once bare a description", () => {
    for (const [schema, names] of [
      [ContextQuerySchema, ["level", "type", "mount"]],
      [RecallQuerySchema, ["include-tombstoned", "limit"]],
      [AnnotateInputSchema, ["session"]],
      [ForgetInputSchema, ["session"]],
    ] as const) {
      const flags = flagsFromSchema(schema);
      for (const n of names) {
        const desc = (flags[n] as { description?: string }).description ?? "";
        expect(desc, `${n}`).not.toBe("");
        expect(toKebab(desc), `${n}`).not.toBe(n);
      }
    }
  });
  it("unwraps a nullable field to its one type and keeps a real union as a string", () => {
    const schema = z.object({
      maybeCount: z.number().int().nullable().describe("A count or null"),
      either: z.union([z.string(), z.number()]).optional(),
    });
    const flags = flagsFromSchema(schema);
    expect((flags["maybe-count"] as { type?: string }).type).toBe("option");
    expect((flags["maybe-count"] as { description?: string }).description).toBe("A count or null");
    expect((flags.either as { description?: string }).description).toBe("either");
    expect(inputFromFlags(schema, { "maybe-count": 3, either: "x" })).toEqual({
      maybeCount: 3,
      either: "x",
    });
  });
  it("kebab-cases camelCase", () => {
    expect(toKebab("validFrom")).toBe("valid-from");
  });
});
