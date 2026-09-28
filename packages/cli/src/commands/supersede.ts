import { SupersedeInputSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Supersede extends YnmCommand {
  static override description = "Record a new version of an existing memory";
  static override examples = [
    '<%= config.bin %> <%= command.id %> --memory-id 01J... --content "Updated text"',
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(SupersedeInputSchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Supersede);
    const { json, cwd, ...rest } = flags;
    const { ynm } = await this.open({ cwd });
    const r = await ynm.supersede(inputFromFlags(SupersedeInputSchema, rest));
    this.emit(json, r, () => `superseded ${r.memoryId} (record ${r.recordId})`);
  }
}
