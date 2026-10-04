import { createHash } from "node:crypto";
import { z } from "zod";
import { IsoDateTimeSchema } from "./record.js";

/**
 * People (ADR-017): who wrote a memory, independent of the identity provider. A person id is
 * derived from the first login (issuer and subject) a person signs in with, so it needs no write
 * to exist; the people document links later logins (another provider) to it and holds the
 * nickname each person chooses. Records carry only the person id.
 */
export const PERSON_ID_PATTERN = /^p[a-z2-7]{16}$/;
export const PersonIdSchema = z.string().regex(PERSON_ID_PATTERN, "must be a person id (p + 16)");

export const NicknameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\n\r\t]+$/, "one line")
  .describe("How this person appears to everyone who can read the store; not a real name");

/** The login an identity provider vouches for: its issuer and the subject it issued. */
export interface Login {
  issuer: string;
  subject: string;
}

export const loginKey = (l: Login): string => `${l.issuer} ${l.subject}`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The person id a login gets when no other person claims it: `p` + 16 base32 characters. */
export function personIdFor(l: Login): string {
  const bytes = createHash("sha256").update(`${l.issuer}\n${l.subject}`).digest();
  let bits = 0;
  let value = 0;
  let out = "p";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 17) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 17) break;
  }
  return out;
}

export const PersonSchema = z
  .object({
    nickname: NicknameSchema.optional(),
    /** Logins linked to this person besides the one its id was derived from. */
    logins: z.array(z.string().min(3)).default([]),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type Person = z.infer<typeof PersonSchema>;

export const PeopleDocSchema = z
  .object({
    v: z.literal(1),
    people: z.record(PersonIdSchema, PersonSchema).default({}),
  })
  .strict();
export type PeopleDoc = z.infer<typeof PeopleDocSchema>;

export const PEOPLE_DOCUMENT = "people";
export const emptyPeople = (): PeopleDoc => ({ v: 1, people: {} });

export function parsePeople(text: string | null | undefined): PeopleDoc {
  if (!text) return emptyPeople();
  return PeopleDocSchema.parse(JSON.parse(text));
}

/** The person a login belongs to: whoever links it, else the id derived from it. */
export function resolvePerson(doc: PeopleDoc, l: Login): string {
  const key = loginKey(l);
  for (const [id, p] of Object.entries(doc.people)) if (p.logins.includes(key)) return id;
  return personIdFor(l);
}

/** Two copies of the document changed apart: per person, the newer entry wins and logins add up. */
export function mergePeople(a: PeopleDoc, b: PeopleDoc): PeopleDoc {
  const out: PeopleDoc = { v: 1, people: { ...a.people } };
  for (const [id, theirs] of Object.entries(b.people)) {
    const ours = out.people[id];
    if (!ours) {
      out.people[id] = theirs;
      continue;
    }
    const newer = theirs.updatedAt > ours.updatedAt ? theirs : ours;
    out.people[id] = { ...newer, logins: [...new Set([...ours.logins, ...theirs.logins])] };
  }
  return out;
}

/** The text form of mergePeople, for a store's sync. */
export const mergePeopleText = (ours: string, theirs: string): string =>
  `${JSON.stringify(mergePeople(parsePeople(ours), parsePeople(theirs)), null, 2)}\n`;

/** The person id in an actor written by a signed-in person (`user:<person id>`), if it is one. */
export function personOfActor(actor: string | undefined): string | undefined {
  const bare = actor?.startsWith("user:") ? actor.slice(5) : undefined;
  return bare && PERSON_ID_PATTERN.test(bare) ? bare : undefined;
}

/**
 * How an actor is shown: a person's nickname, else their person id; any other actor (user:david,
 * agent:claude-code, token:static) as it was written, without the `user:` prefix.
 */
export function authorName(actor: string | undefined, doc: PeopleDoc): string | undefined {
  if (!actor) return undefined;
  const bare = actor.startsWith("user:") ? actor.slice(5) : actor;
  return PERSON_ID_PATTERN.test(bare) ? (doc.people[bare]?.nickname ?? bare) : bare;
}

/** What `memory_people` takes: the caller's own entry only. */
export const PeopleInputSchema = z
  .object({
    action: z
      .enum(["whoami", "nickname", "clear"])
      .describe("whoami: your person id and login; nickname: set yours; clear: remove yours"),
    nickname: NicknameSchema.optional().describe(
      "For nickname: how you appear to everyone who can read the store; not a real name"
    ),
  })
  .strict();
export type PeopleInput = z.infer<typeof PeopleInputSchema>;
