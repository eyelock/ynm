---
name: ynm-memory
description: Use persistent memory (ynm) deliberately - recall before answering, remember decisions and preferences, supersede rather than duplicate. Tools memory_* come from the ynm extension; the same operations are available as `ynm <command> --json`.
---

# Using memory in this session

You have a persistent memory store (ynm). Use it deliberately:

1. **Start** by reading the context block (`memory_context`) or calling `memory_recall` with the
   task's key terms before answering questions about the project, the user or past decisions.
2. **Remember** facts that will matter beyond this conversation: decisions and their reasons,
   user preferences, conventions, gotchas you hit, and outcomes of work. One memory per fact.
   Choose the type: `semantic` (facts), `episodic` (what happened), `procedural` (how to do
   things), `reference` (pointers), `working` (only for this session, needs a ttl).
3. **Level**: `personal` unless the fact is about the shared project and safe for the team, then
   `distributed`. Never store secrets, tokens or credentials.
4. **Update, don't duplicate**: if a memory exists and is now wrong or incomplete, use
   `memory_supersede`. If it is obsolete, `memory_forget`.
5. **Be quiet about it**: do not narrate memory operations unless asked.

# When to remember

Remember when a fact would change how you or a colleague acts next time:

- a decision was made and why (semantic, often distributed)
- the user stated a preference or corrected you (semantic, personal)
- a procedure that took effort to discover: commands, order of steps, flags (procedural)
- something surprising happened, including failures and their cause (episodic)
- a document, ticket, dashboard or URL that will be needed again (reference)

Do not remember: anything derivable from the code or git history, transient task state,
secrets, or large pasted content. Prefer a one-line summary and a short body.

# When to promote to procedural or distributed

- Two or more episodic memories describe the same recurring situation: write one procedural
  memory that says what to do, link it `derives-from` the episodes.
- A personal memory turns out to be a team convention: use `memory_promote` or ask the user
  before sharing; promotion copies it into the shared store and links back.
- A distributed procedural memory is the closest thing to a rule; keep them short, imperative
  and specific to this project.

## CLI parity

Every tool is also a command with the same flags: `ynm remember`, `ynm recall`, `ynm context`, `ynm supersede`, `ynm annotate`, `ynm forget`, `ynm session`, `ynm dream`, `ynm sync`, `ynm status`. Add `--json` for machine-readable output.
