/**
 * Milestone gate: M3 MCP local (MVP). See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
describe("gate M3: M3 MCP local (MVP)", () => {
  it.todo("ADR-008: every MCP tool has a CLI command with the same schema (parity)");
  it.todo(
    "ADR-008: every tool exercised over JSON-RPC through an in-memory client, not by calling handlers"
  );
  it.todo("ADR-009: stdio and HTTP transports serve a bare repo with no working tree");
  it.todo("NFR-11: two interleaved HTTP clients share no state");
  it.todo(
    "ADR-013: golden tests for claude-code and ynh adapters; ynh validate passes on the checked-in plugin"
  );
  it.todo(
    "FR-14: guidance efficacy live eval baseline recorded (agent remembers and recalls at the right moments)"
  );
  it.todo("MVP: end-to-end demo script (init, install, two sessions, recall) passes");
});
