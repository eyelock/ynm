import {
  authorName,
  emptyPeople,
  loginKey,
  mergePeople,
  mergePeopleText,
  PERSON_ID_PATTERN,
  PeopleInputSchema,
  parsePeople,
  personIdFor,
  personOfActor,
  resolvePerson,
} from "./people.js";

const auth0 = { issuer: "https://tenant.us.auth0.com/", subject: "auth0|6ac0" };
const okta = { issuer: "https://login.example.com/", subject: "00u1abc" };
const at = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();

describe("people (ADR-017)", () => {
  it("derives a stable, namespace-safe person id from a login", () => {
    const id = personIdFor(auth0);
    expect(id).toMatch(PERSON_ID_PATTERN);
    expect(personIdFor({ ...auth0 })).toBe(id);
    expect(personIdFor(okta)).not.toBe(id);
    // The same subject at another issuer is another person.
    expect(personIdFor({ ...auth0, issuer: "https://other.us.auth0.com/" })).not.toBe(id);
  });

  it("resolves a linked login to its person, any other to its derived id", () => {
    const person = personIdFor(auth0);
    const doc = {
      v: 1 as const,
      people: { [person]: { logins: [loginKey(okta)], updatedAt: at(1) } },
    };
    expect(resolvePerson(doc, okta)).toBe(person);
    expect(resolvePerson(doc, auth0)).toBe(person);
    expect(resolvePerson(emptyPeople(), okta)).toBe(personIdFor(okta));
  });

  it("merges two copies: the newer entry wins per person and logins add up", () => {
    const a = personIdFor(auth0);
    const b = personIdFor(okta);
    const ours = {
      v: 1 as const,
      people: { [a]: { nickname: "Dave", logins: ["x y"], updatedAt: at(2) } },
    };
    const theirs = {
      v: 1 as const,
      people: {
        [a]: { nickname: "David", logins: ["z w"], updatedAt: at(3) },
        [b]: { nickname: "Sam", logins: [], updatedAt: at(1) },
      },
    };
    const merged = mergePeople(ours, theirs);
    expect(merged.people[a]).toEqual({
      nickname: "David",
      logins: ["x y", "z w"],
      updatedAt: at(3),
    });
    expect(merged.people[b]?.nickname).toBe("Sam");
    expect(mergePeople(theirs, ours).people[a]?.nickname).toBe("David");
    expect(parsePeople(mergePeopleText(JSON.stringify(ours), JSON.stringify(theirs)))).toEqual(
      merged
    );
  });

  it("parses an empty or missing document as no people, and refuses a bad one", () => {
    expect(parsePeople(null)).toEqual(emptyPeople());
    expect(parsePeople("")).toEqual(emptyPeople());
    expect(() => parsePeople('{"v":1,"people":{"david":{"updatedAt":"x"}}}')).toThrow();
  });

  it("shows a person by nickname, else id; any other actor as written", () => {
    const id = personIdFor(auth0);
    const doc = {
      v: 1 as const,
      people: { [id]: { nickname: "David", logins: [], updatedAt: at(1) } },
    };
    expect(personOfActor(`user:${id}`)).toBe(id);
    expect(personOfActor("user:david")).toBeUndefined();
    expect(personOfActor(undefined)).toBeUndefined();
    expect(authorName(`user:${id}`, doc)).toBe("David");
    expect(authorName(`user:${id}`, emptyPeople())).toBe(id);
    expect(authorName("user:david", doc)).toBe("david");
    expect(authorName("agent:claude-code", doc)).toBe("agent:claude-code");
    expect(authorName(undefined, doc)).toBeUndefined();
  });

  it("takes a one-line nickname only", () => {
    expect(PeopleInputSchema.parse({ action: "nickname", nickname: " David " }).nickname).toBe(
      "David"
    );
    expect(() => PeopleInputSchema.parse({ action: "nickname", nickname: "a\nb" })).toThrow();
    expect(() => PeopleInputSchema.parse({ action: "rename" })).toThrow();
  });
});
