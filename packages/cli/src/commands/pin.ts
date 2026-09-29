import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Pin extends YnmCommand {
  static override description = "Pin a memory so it is always in the context block (or unpin it)";
  static override examples = [
    "<%= config.bin %> <%= command.id %> 01J...",
    "<%= config.bin %> <%= command.id %> 01J... --unpin",
  ];
  static override args = { memoryId: Args.string({ required: true, description: "Memory id" }) };
  static override flags = {
    ...YnmCommand.baseFlags,
    unpin: Flags.boolean({ description: "Remove the pin", default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Pin);
    const { ynm } = await this.open(flags);
    const r = await ynm.pin(args.memoryId, !flags.unpin);
    this.emit(flags.json, r, () => `${flags.unpin ? "unpinned" : "pinned"} ${r.memoryId}`);
  }
}
