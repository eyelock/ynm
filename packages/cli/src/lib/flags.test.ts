import { RememberInputSchema } from "@ynm/model";
import { flagsFromSchema, inputFromFlags, toKebab } from "./flags.js";

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
  it("kebab-cases camelCase", () => {
    expect(toKebab("validFrom")).toBe("valid-from");
  });
});
