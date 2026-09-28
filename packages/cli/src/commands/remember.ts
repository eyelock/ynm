import { Flags } from "@oclif/core";
import { RememberInputSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Remember extends YnmCommand {
  static override description = "Record a memory";
  static override examples = [
    '<%= config.bin %> <%= command.id %> --type semantic --content "Notes anchor to the root commit"',
    '<%= config.bin %> <%= command.id %> --type procedural --level distributed --content "Run pnpm check before pushing" --tags ci',
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    ...flagsFromSchema(RememberInputSchema),
    mount: Flags.string({ description: "Target mount id (defaults by level)" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Remember);
    const { json, cwd, mount, ...rest } = flags;
    const input = inputFromFlags(RememberInputSchema, rest);
    const { ynm } = await this.open({ cwd });
    const r = await ynm.remember(input, mount);
    this.emit(json, r, () => `remembered ${r.memoryId} in ${r.mount}`);
  }
}
