/**
 * Milestone gate: M4 Lifecycle. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
describe("gate M4: M4 Lifecycle", () => {
  it.todo(
    "ADR-006: dedupe, contradiction and promotion precision and recall meet baseline per Judge implementation"
  );
  it.todo("ADR-006: every dream pass has a no-model fallback that runs with no keys");
  it.todo(
    "ADR-012: Writer output fails closed on schema mismatch; judgments stored as annotate data; thresholds read from config"
  );
  it.todo(
    "ADR-012: reflect pass verified by the Noul battery; unsupported-claim rate under baseline"
  );
  it.todo("ADR-005: Judge-backed reranker shows recall@k lift over lexical only");
  it.todo(
    "ADR-010: wiki golden files for index, log, entity and topic pages on both targets; wiki ingest round-trips"
  );
  it.todo("ADR-002: purge leaves a purge-marker and history intact until --forget-history");
  it.todo(
    "Exit: a 10k store with 5% duplicates and 2% contradictions is cleaned by one dream run within baseline at a recorded cost"
  );
});
