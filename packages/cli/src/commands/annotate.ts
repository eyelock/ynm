import { AnnotateInputSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Annotate extends YnmCommand {
  static override description =
    "Add tags, links, pin, importance or review flags without changing content";
  static override examples = [
    "<%= config.bin %> <%= command.id %> --memory-id 01J... --pinned --importance 0.9",
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(AnnotateInputSchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Annotate);
    const { json, cwd, ...rest } = flags;
    const { ynm } = await this.open({ cwd });
    const r = await ynm.annotate(inputFromFlags(AnnotateInputSchema, rest));
    this.emit(json, r, () => `annotated ${r.memoryId} (record ${r.recordId})`);
  }
}
