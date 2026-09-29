/** Shared tokenizer so every lexical implementation and query agrees on what a word is. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[-./]+|[-./]+$/g, ""))
    .filter((t) => t.length > 1);
}

/** Rough token count for budgets: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
