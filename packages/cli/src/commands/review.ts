import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Review extends YnmCommand {
  static override description = "List memories flagged for review, or clear a flag after deciding";
  static override examples = [
    "<%= config.bin %> <%= command.id %> list",
    "<%= config.bin %> <%= command.id %> clear 01J...",
  ];
  static override args = {
    action: Args.string({
      required: true,
      options: ["list", "clear"],
      description: "list or clear",
    }),
    memoryId: Args.string({ description: "Memory id (for clear)" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Only this mount" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Review);
    const { ynm } = await this.open(flags);
    if (args.action === "clear") {
      if (!args.memoryId) this.error("memoryId required", { exit: 2 });
      const r = await ynm.annotate({
        memoryId: args.memoryId,
        needsReview: false,
        reason: "reviewed",
      });
      this.emit(flags.json, r, () => `cleared review flag on ${r.memoryId}`);
      return;
    }
    const q = await ynm.reviewQueue(flags.mount);
    this.emit(flags.json, q, () =>
      q.length
        ? q
            .map(
              (m) =>
                `${m.memoryId}  ${m.type.padEnd(10)} ${m.mount.padEnd(9)} ${m.current.summary ?? ""}`
            )
            .join("\n")
        : "nothing to review"
    );
  }
}
