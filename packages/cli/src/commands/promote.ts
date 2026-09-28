import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Promote extends YnmCommand {
  static override description =
    "Copy a personal memory into a distributed mount as a new, linked memory";
  static override examples = ["<%= config.bin %> <%= command.id %> 01J..."];
  static override args = {
    memoryId: Args.string({ required: true, description: "Personal memory id" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Target distributed mount" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Promote);
    const { ynm } = await this.open(flags);
    const r = await ynm.promote(args.memoryId, flags.mount);
    this.emit(flags.json, r, () => `promoted ${args.memoryId} -> ${r.memoryId} in ${r.mount}`);
  }
}
