/**
 * Serialises `value` the way `original` was written, so merging a key into someone's file does not
 * rewrite the rest of it: the same indentation, `\\uXXXX` escapes for non-ASCII when the original
 * used them, and the same trailing newline. A new file gets two spaces and a newline.
 */
export function stringifyLike(original: string | undefined, value: unknown): string {
  const lead = original?.match(/\n([ \t]+)\S/)?.[1];
  const indent = lead ? (lead.startsWith("\t") ? "\t" : lead.length) : 2;
  let out = JSON.stringify(value, null, indent);
  if (
    original &&
    /\\u[0-9a-fA-F]{4}/.test(original) &&
    ![...original].some((ch) => ch.charCodeAt(0) > 0x7f)
  )
    out = out.replace(
      /[\u0080-\uffff]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
  return original === undefined || original.endsWith("\n") ? `${out}\n` : out;
}
