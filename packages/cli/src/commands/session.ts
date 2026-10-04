import { Args, Flags } from "@oclif/core";
import { emptyContextNote, Lifecycle } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Session extends YnmCommand {
  static override description =
    "Start a session (prints the context block) or end one (expires working memory)";
  static override examples = [
    "<%= config.bin %> <%= command.id %> start",
    "<%= config.bin %> <%= command.id %> end <sessionId>",
  ];
  static override args = {
    action: Args.string({
      ignoreStdin: true,
      required: true,
      options: ["start", "end"],
      description: "start or end",
    }),
    sessionId: Args.string({ ignoreStdin: true, description: "Session id (required for end)" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    namespace: Flags.string({ description: "Namespace prefix for the context block" }),
    "budget-tokens": Flags.integer({ description: "Context block budget", default: 1500 }),
    ttl: Flags.string({ description: "Default working-memory TTL", default: "PT8H" }),
    expire: Flags.boolean({
      description: "On end, tombstone expired working memory",
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Session);
    const { ynm } = await this.open(flags);
    const life = new Lifecycle(ynm);
    if (args.action === "start") {
      const s = await life.start({
        sessionId: args.sessionId,
        namespace: flags.namespace,
        budgetTokens: flags["budget-tokens"],
        ttl: flags.ttl,
      });
      this.emit(
        flags.json,
        s,
        () =>
          `session ${s.sessionId}\nworking namespace ${s.namespace} (ttl ${s.ttl})\n\n${s.context.markdown || emptyContextNote(s.context.truncated)}`
      );
      return;
    }
    if (!args.sessionId) this.error("session end needs a sessionId", { exit: 2 });
    const e = await life.end({ sessionId: args.sessionId, expire: flags.expire });
    this.emit(
      flags.json,
      e,
      () =>
        `ended ${e.sessionId}; expired ${e.expired.length} working memor${e.expired.length === 1 ? "y" : "ies"}`
    );
  }
}
