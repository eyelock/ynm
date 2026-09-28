import { ForgetInputSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Forget extends YnmCommand {
  static override description = "Tombstone a memory (history is kept)";
  static override examples = [
    '<%= config.bin %> <%= command.id %> --memory-id 01J... --reason "no longer true"',
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(ForgetInputSchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Forget);
    const { json, cwd, ...rest } = flags;
    const { ynm } = await this.open({ cwd });
    const r = await ynm.forget(inputFromFlags(ForgetInputSchema, rest));
    this.emit(json, r, () => `forgot ${r.memoryId} (record ${r.recordId})`);
  }
}
