/**
 * Milestone gate: M5 Hosted. See .claude/plans/milestones.md (untracked) and docs/adr/014.
 * A milestone closes when this file is green with zero todos.
 */
describe("gate M5: M5 Hosted", () => {
  it.todo("ADR-009: Docker HTTP integration: auth, two clients, dream worker, local clone sync");
  it.todo(
    "ADR-004: conformance suite passes on sqlite; hosted suite runs unchanged on git-notes and sqlite"
  );
  it.todo(
    "ADR-013: golden tests for copilot-cli, opencode and pi adapters; Pi extension tool tests"
  );
  it.todo("NFR-6: hosted suite passes against a bare repo on a Gitea container");
  it.todo(
    "Exit: docker compose demo with one hosted store, one HTTP agent client, one syncing clone"
  );
});
