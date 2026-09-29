import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Purge extends YnmCommand {
  static override description =
    "Physically remove a memory's records (leaves an audited purge marker)";
  static override examples = [
    '<%= config.bin %> <%= command.id %> 01J... --reason "contained personal data" --yes',
  ];
  static override args = { memoryId: Args.string({ required: true, description: "Memory id" }) };
  static override flags = {
    ...YnmCommand.baseFlags,
    reason: Flags.string({ description: "Recorded in the purge marker", required: true }),
    "forget-history": Flags.boolean({
      description: "Also drop the shard's ref history",
      default: false,
    }),
    yes: Flags.boolean({ description: "Confirm the removal", default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Purge);
    if (!flags.yes) this.error("purge is irreversible; re-run with --yes to confirm", { exit: 2 });
    const { ynm } = await this.open(flags);
    const r = await ynm.purge({
      memoryId: args.memoryId,
      reason: flags.reason,
      forgetHistory: flags["forget-history"],
    });
    this.emit(
      flags.json,
      r,
      () => `purged ${r.memoryId}: ${r.removed} record(s) removed from ${r.mount}`
    );
  }
}
