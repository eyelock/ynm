import type { Question } from "@ynm/models";

/** Typed question definitions, versioned with the record schema (ADR-012). Ids are code-facing. */
export const PAIR_QUESTIONS = {
  sameFact: {
    type: "noul",
    instructions: "Do memories `a` and `b` state the same fact, decision, preference or procedure?",
    criteria: {
      true: "Both express the same underlying fact, possibly in different words or with minor extra detail.",
      false: "They express different facts, or one adds, removes or changes a material claim.",
    },
  },
  relation: {
    type: "score",
    instructions: "How do memories `a` and `b` relate?",
    criteria: [
      "They describe different things.",
      "They are about the same subject but say different things.",
      "They say the same thing.",
    ],
  },
  contradicts: {
    type: "noul",
    instructions:
      "Do `a` and `b` make incompatible claims about the same thing, such that both cannot be true at once?",
    criteria: {
      true: "They assert conflicting values, states or instructions for the same subject.",
      false: "They are compatible, unrelated, or one merely adds detail.",
    },
  },
} as const satisfies Record<string, Question>;

export const SUPERSEDE_QUESTION = {
  newerSupersedes: {
    type: "noul",
    instructions:
      "Given that `a` (older) and `b` (newer) conflict, does the newer memory `b` supersede the older `a` (a state change or correction), rather than being a mistake?",
    criteria: {
      true: "`b` reads as an update or correction that replaces `a`.",
      false: "`b` looks like an error or a different context; `a` should stand.",
    },
  },
} as const satisfies Record<string, Question>;

export const PROMOTE_QUESTIONS = {
  usefulLater: {
    type: "noul",
    instructions:
      "Would this session `memory` still be useful in a future session (a decision, preference, procedure, or durable fact) rather than transient task state?",
    criteria: {
      true: "It records something durable a future session would want.",
      false: "It is scratch state, progress notes, or only meaningful inside this session.",
    },
  },
  kind: {
    type: "choice",
    instructions: "If kept, which memory type fits `memory` best?",
    criteria: {
      semantic: "a fact about the world, the user or the project",
      episodic: "something that happened",
      procedural: "how to do something",
      reference: "a pointer to an external resource",
    },
  },
} as const satisfies Record<string, Question>;

export const VERIFY_QUESTIONS = {
  unsupported: {
    type: "noul",
    instructions: "Does the `summary` make any claim that the `sources` do not support?",
    criteria: {
      true: "At least one claim in the summary is absent from or contradicted by the sources.",
      false: "Every claim in the summary is grounded in the sources.",
    },
  },
  lostFact: {
    type: "noul",
    instructions: "Does the `summary` omit a fact from the `sources` that a reader would need?",
    criteria: {
      true: "A material fact, decision or outcome in the sources is missing from the summary.",
      false: "The summary keeps every material fact.",
    },
  },
  wrongDate: {
    type: "noul",
    instructions:
      "Does the `summary` state a date, order of events or duration that disagrees with the `sources`?",
  },
} as const satisfies Record<string, Question>;

export const WRITE_QUESTIONS = {
  importance: {
    type: "score",
    instructions:
      "How important is this `memory` for future work: how much would forgetting it cost?",
    criteria: [
      "Trivial or transient; forgetting costs nothing.",
      "Minor; mildly useful.",
      "Useful; would save some effort.",
      "Important; a decision, preference or convention others rely on.",
      "Critical; forgetting it would cause errors or rework.",
    ],
  },
  sensitive: {
    type: "noul",
    instructions:
      "Does `memory` contain a secret, credential, private key, or personal data that must not be stored?",
    criteria: {
      true: "It contains a password, token, API key, private key, or personal identifying data.",
      false: "It contains no secret or personal data.",
    },
  },
} as const satisfies Record<string, Question>;

export const RERANK_QUESTION = {
  answers: {
    type: "noul",
    instructions: "Would the `memory` help answer or act on the `query`?",
    criteria: {
      true: "The memory contains information the query is asking for or depends on.",
      false: "The memory is about something else or only shares words with the query.",
    },
  },
} as const satisfies Record<string, Question>;
