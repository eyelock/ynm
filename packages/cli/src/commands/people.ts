import { Args, Flags } from "@oclif/core";
import { NicknameSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";

export default class People extends YnmCommand {
  static override description =
    "Who writes to this store: list people and their nicknames, set or clear a nickname, or link a login from another identity provider to an existing person";
  static override examples = [
    "<%= config.bin %> <%= command.id %> list",
    "<%= config.bin %> <%= command.id %> nickname pabcdefghijklmnop --nickname David",
    "<%= config.bin %> <%= command.id %> clear pabcdefghijklmnop",
    "<%= config.bin %> <%= command.id %> link pabcdefghijklmnop --issuer https://login.example.com/ --subject 00u1abc",
  ];
  static override args = {
    action: Args.string({
      ignoreStdin: true,
      required: true,
      options: ["list", "whoami", "nickname", "clear", "link"],
      description: "list, whoami, nickname, clear or link",
    }),
    person: Args.string({ ignoreStdin: true, description: "Person id (nickname, clear, link)" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    nickname: Flags.string({
      description: "For nickname: how the person appears to everyone who can read the store",
    }),
    issuer: Flags.string({ description: "For link: the login's issuer, as its tokens state it" }),
    subject: Flags.string({ description: "For link: the login's subject at that issuer" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(People);
    const { ynm, loaded } = await this.open(flags);
    const person = () => args.person ?? this.error(`${args.action} needs a person id`, { exit: 2 });
    switch (args.action) {
      case "whoami": {
        const actor = loaded.config.actor;
        this.emit(
          flags.json,
          { actor },
          () =>
            `${actor} on this machine; on a hosted store you write as the person your sign-in resolves to (ask the agent for memory_people whoami)`
        );
        return;
      }
      case "nickname": {
        if (!flags.nickname) this.error("nickname needs --nickname", { exit: 2 });
        const id = person();
        const doc = await ynm.setNickname(id, NicknameSchema.parse(flags.nickname));
        this.emit(flags.json, doc.people[id], () => `${id} is now shown as ${flags.nickname}`);
        return;
      }
      case "clear": {
        const id = person();
        const doc = await ynm.setNickname(id, undefined);
        this.emit(flags.json, doc.people[id], () => `cleared the nickname of ${id}`);
        return;
      }
      case "link": {
        if (!flags.issuer || !flags.subject)
          this.error("link needs --issuer and --subject", { exit: 2 });
        const id = person();
        const doc = await ynm.linkLogin({ issuer: flags.issuer, subject: flags.subject }, id);
        this.emit(
          flags.json,
          doc.people[id],
          () => `linked ${flags.issuer} ${flags.subject} to ${id}: it now writes as that person`
        );
        return;
      }
      default: {
        const doc = await ynm.people(true);
        const rows = Object.entries(doc.people);
        this.emit(flags.json, doc, () =>
          rows.length
            ? rows
                .map(
                  ([id, p]) =>
                    `${id}  ${(p.nickname ?? "-").padEnd(20)} ${p.logins.length} linked login${p.logins.length === 1 ? "" : "s"}`
                )
                .join("\n")
            : "no people yet: a person appears once they set a nickname or a login is linked to them"
        );
      }
    }
  }
}
