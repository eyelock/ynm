import { z } from "zod";
import { extractJson } from "../json.js";
import {
  StructuredOutputError,
  type Usage,
  type WriteRequest,
  type Writer,
  type Written,
} from "../types.js";

export interface RawCompletion {
  text: string;
  model: string;
  usage?: Usage;
}

/**
 * Shared fail-closed loop: ask, extract JSON, validate with Zod, retry once with the issues,
 * then reject (ADR-012). Concrete writers only implement `complete`.
 */
export abstract class ValidatingWriter implements Writer {
  abstract readonly name: string;
  protected abstract complete(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    schemaName: string
  ): Promise<RawCompletion>;

  protected prompt<T>(
    req: WriteRequest<T>,
    jsonSchema: Record<string, unknown>,
    priorIssues?: string
  ): string {
    return [
      req.instructions,
      "",
      "Input (JSON):",
      JSON.stringify(req.state, null, 2),
      "",
      "Respond with a single JSON value that matches this JSON Schema exactly. No prose, no code fences.",
      JSON.stringify(jsonSchema),
      ...(priorIssues ? ["", `Your previous answer was rejected: ${priorIssues}. Fix it.`] : []),
    ].join("\n");
  }

  async write<T>(req: WriteRequest<T>): Promise<Written<T>> {
    const name = req.schemaName ?? "output";
    const jsonSchema = z.toJSONSchema(req.schema as z.ZodType, {
      unrepresentable: "any",
    }) as Record<string, unknown>;
    let issues: string | undefined;
    let usage: Usage | undefined;
    let model = this.name;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const raw = await this.complete(this.prompt(req, jsonSchema, issues), jsonSchema, name);
      model = raw.model;
      if (raw.usage)
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + raw.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + raw.usage.outputTokens,
        };
      let parsed: unknown;
      try {
        parsed = extractJson(raw.text);
      } catch (e) {
        issues = (e as Error).message;
        continue;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return { value: result.data, model, usage };
      issues = result.error.issues
        .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
        .join("; ");
    }
    throw new StructuredOutputError(2, issues ?? "unknown");
  }
}
