/**
 * Milestone gate: M2 Recall. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
describe("gate M2: M2 Recall", () => {
  it.todo("ADR-005: recall@10 on the synthetic corpus meets baseline per type and namespace");
  it.todo("ADR-005: index conformance suite passes on sqlite-fts and memory indexes");
  it.todo("ADR-005: reindex from the log reproduces identical hits");
  it.todo("ADR-005: p95 recall and context under budget at 100k on the reference machine");
  it.todo("ADR-002: data string values are searchable and keys filterable");
  it.todo("NFR-13: the whole M2 suite runs with no API keys in the environment");
});
