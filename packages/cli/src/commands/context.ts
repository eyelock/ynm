import { ContextQuerySchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Context extends YnmCommand {
  static override description =
    "Print the session-start memory block: pinned first, then ranked, within a token budget";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    '<%= config.bin %> <%= command.id %> --text "release" --budget-tokens 800',
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(ContextQuerySchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Context);
    const { json, cwd, ...rest } = flags;
    const q = inputFromFlags(ContextQuerySchema, rest);
    const { ynm } = await this.open({ cwd });
    const block = await ynm.context(q);
    this.emit(json, block, () => block.markdown);
  }
}
