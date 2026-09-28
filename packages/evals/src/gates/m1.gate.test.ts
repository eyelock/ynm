/**
 * Milestone gate: M1 Log. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
describe("gate M1: M1 Log", () => {
  it.todo("ADR-001: store rejects a personal record appended to a distributed log");
  it.todo(
    "ADR-001: namespace validation accepts unbounded hierarchical paths and rejects bad segments"
  );
  it.todo(
    "ADR-002: fold over random op sequences (property test) yields supersede-wins, tombstone-hides, snapshot-equivalent state"
  );
  it.todo("ADR-002: a corrupt JSONL line is skipped and reported, never fatal");
  it.todo(
    "ADR-003: anchor selection picks the oldest root commit, honours config override, works on shallow clones and empty repos"
  );
  it.todo(
    "ADR-003: two clones write independently, sync both ways, zero records lost, shards merge with cat_sort_uniq"
  );
  it.todo(
    "ADR-003: N concurrent local writers on one shard lose zero records (lock plus update-ref CAS)"
  );
  it.todo("ADR-003: full load uses batched plumbing (two git processes for 1000 shards, not N)");
  it.todo("ADR-004: conformance suite passes on memory, fs and git-notes providers");
  it.todo("ADR-004: nothing above store imports a provider (dependency rule test)");
  it.todo("ADR-007: init never writes personal refs or personal push refspecs into a project repo");
  it.todo(
    "ADR-007: promote creates a new shared record with a derives-from link and leaves the personal original untouched"
  );
  it.todo("ADR-009: init on a repo with history changes no branch, tag or tracked file");
  it.todo("ADR-014: latency baselines for remember, load and sync recorded at 1k, 10k, 100k");
});
