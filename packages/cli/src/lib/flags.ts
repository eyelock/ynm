import { Flags, type Interfaces } from "@oclif/core";
import { z } from "zod";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  format?: string;
};

/** Malformed flag input: reported as `invalid input: ...` with exit code 2. */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}

export function toKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function unwrap(s: JsonSchema): JsonSchema {
  if (s.anyOf) {
    const nonNull = s.anyOf.filter((x) => x.type !== "null");
    if (nonNull.length === 1 && nonNull[0])
      return { ...nonNull[0], description: s.description ?? nonNull[0].description };
  }
  return s;
}

function typeOf(s: JsonSchema): string {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  return t ?? (s.enum ? "string" : "string");
}

/** A scalar default worth showing in `--help`; empty arrays and objects are noise. */
function defaultText(s: JsonSchema): string | undefined {
  const d = s.default;
  if (d === undefined || d === null || typeof d === "object") return undefined;
  return String(d);
}

/**
 * oclif flags generated from a Zod object via its JSON Schema (ADR-008 parity). Strings, enums,
 * numbers, booleans and string arrays map directly; objects and object arrays take JSON.
 */
export function flagsFromSchema<T extends z.ZodObject>(
  schema: T,
  options: { exclude?: string[] } = {}
): Interfaces.FlagInput {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const out: Interfaces.FlagInput = {};
  for (const [name, raw] of Object.entries(json.properties ?? {})) {
    if (options.exclude?.includes(name)) continue;
    const prop = unwrap(raw);
    const required = (json.required ?? []).includes(name) && prop.default === undefined;
    const base = prop.description ?? name;
    const dflt = defaultText(prop);
    const withDefault = (d: string): string => (dflt ? `${d} (default: ${dflt})` : d);
    const description = withDefault(base);
    const flag = toKebab(name);
    const t = typeOf(prop);
    if (prop.enum) {
      out[flag] = Flags.string({ description, required, options: prop.enum.map(String) });
    } else if (t === "boolean") {
      out[flag] = Flags.boolean({ description, allowNo: true });
    } else if (t === "integer") {
      out[flag] = Flags.integer({ description, required });
    } else if (t === "number") {
      out[flag] = Flags.string({ description: withDefault(`${base} (number)`), required });
    } else if (t === "array") {
      const item = prop.items ? unwrap(prop.items) : {};
      if (typeOf(item) === "string" || item.enum) {
        out[flag] = Flags.string({
          description: item.enum ? base : `${base} (repeat the flag or separate with commas)`,
          required,
          multiple: true,
          options: item.enum?.map(String),
        });
      } else {
        out[flag] = Flags.string({ description: `${base} (JSON array)`, required });
      }
    } else if (t === "object") {
      out[flag] = Flags.string({
        description: base.endsWith("(JSON object)") ? base : `${base} (JSON object)`,
        required,
      });
    } else {
      out[flag] = Flags.string({ description, required });
    }
  }
  return out;
}

/** `--tags a,b` is two values, like `--tags a --tags b`. */
function splitCommas(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Converts parsed oclif flags back into the schema's input shape (kebab → camel, JSON, numbers). */
export function inputFromFlags<T extends z.ZodObject>(
  schema: T,
  flags: Record<string, unknown>
): z.infer<T> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const byFlag = new Map<string, [string, JsonSchema]>();
  for (const [name, prop] of Object.entries(json.properties ?? {}))
    byFlag.set(toKebab(name), [name, unwrap(prop)]);
  const input: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    const entry = byFlag.get(flag);
    if (!entry) continue;
    const [name, prop] = entry;
    const t = typeOf(prop);
    if (
      typeof value === "string" &&
      (t === "object" ||
        (t === "array" &&
          prop.items &&
          typeOf(unwrap(prop.items)) !== "string" &&
          !unwrap(prop.items).enum))
    ) {
      try {
        input[name] = JSON.parse(value);
      } catch (err) {
        throw new InvalidInputError(`--${flag}: not valid JSON (${(err as Error).message})`);
      }
    } else if (t === "array" && Array.isArray(value) && !(prop.items && unwrap(prop.items).enum)) {
      input[name] = value.flatMap((v) => (typeof v === "string" ? splitCommas(v) : [v]));
    } else if (typeof value === "string" && t === "number") {
      input[name] = Number(value);
    } else {
      input[name] = value;
    }
  }
  return schema.parse(input);
}
