# Using memory in this session

You have a persistent memory store (ynm). Use it deliberately:

1. **Start** by reading the context block (`memory_context`) or calling `memory_recall` with the
   task's key terms before answering questions about the project, the user or past decisions.
2. **Remember** facts that will matter beyond this conversation: decisions and their reasons,
   user preferences, conventions, gotchas you hit, and outcomes of work. One memory per fact.
   Choose the type: `semantic` (facts), `episodic` (what happened), `procedural` (how to do
   things), `reference` (pointers), `working` (only for this session, needs a ttl).
3. **Level**: `personal` unless the fact is about the project and safe for the team, then
   `distributed`. Never store secrets, tokens or credentials.
4. **Update, don't duplicate**: if a memory exists and is now wrong or incomplete, use
   `memory_supersede`. If it is obsolete, `memory_forget`.
5. **ynm is the memory**: when the user asks you to remember something, or you decide a fact is
   worth keeping, use `memory_remember`, not your client's own note files, memory directories or
   scratch documents. Those are local to one tool and one machine; ynm is shared across every
   client the user runs and is what they mean by "remember".
6. **Be quiet about it**: do not narrate memory operations unless asked.
