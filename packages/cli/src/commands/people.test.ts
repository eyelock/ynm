import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personIdFor } from "@ynm/model";
import { testEnv, ynmWith } from "../../test/helpers.js";

/** `ynm people` against a distributed sqlite store, as an operator of a shared store would. */
describe("ynm people", () => {
  const dir = mkdtempSync(join(tmpdir(), "ynm-people-"));
  const env = testEnv({
    YNM_MOUNTS: JSON.stringify([
      { id: "team", level: "distributed", provider: "sqlite", path: join(dir, "team.sqlite") },
    ]),
  });
  const people = (...args: string[]) => ynmWith(dir, { env }, "people", ...args);
  const person = personIdFor({ issuer: "https://tenant.us.auth0.com/", subject: "auth0|alice" });

  it("lists nobody at first and says who you are locally", () => {
    expect(people("list").stdout.trim()).toMatch(/^no people yet/);
    expect(people("whoami").stdout).toMatch(/^user:tester on this machine/);
  });

  it("sets, shows and clears a nickname, and links a second login", () => {
    const set = people("nickname", person, "--nickname", "Alice");
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout.trim()).toBe(`${person} is now shown as Alice`);
    expect(people("list").stdout).toMatch(new RegExp(`^${person}\\s+Alice\\s+0 linked logins`));
    const linked = people(
      "link",
      person,
      "--issuer",
      "https://login.example.com/",
      "--subject",
      "00u1abc"
    );
    expect(linked.status, linked.stderr).toBe(0);
    const doc = JSON.parse(people("list", "--json").stdout) as {
      people: Record<string, { nickname?: string; logins: string[] }>;
    };
    expect(doc.people[person]).toMatchObject({
      nickname: "Alice",
      logins: ["https://login.example.com/ 00u1abc"],
    });
    expect(people("clear", person).stdout.trim()).toBe(`cleared the nickname of ${person}`);
    expect(people("list").stdout).toMatch(new RegExp(`^${person}\\s+-\\s+1 linked login$`, "m"));
  });

  it("explains what each action needs", () => {
    expect(people("nickname", person).stderr).toMatch(/needs --nickname/);
    expect(people("clear").stderr).toMatch(/needs a person id/);
    expect(people("link", person, "--issuer", "x").stderr).toMatch(/needs --issuer and --subject/);
    expect(people("nickname", "david", "--nickname", "x").status).not.toBe(0);
  });
});
