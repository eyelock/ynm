import { Flags } from "@oclif/core";
import { RecordFilterSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Export extends YnmCommand {
  static override description = "Export raw records as JSONL (the log, including history)";
  static override examples = [
    "<%= config.bin %> <%= command.id %> > memory.jsonl",
    "<%= config.bin %> <%= command.id %> --level distributed",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    ...flagsFromSchema(RecordFilterSchema, { exclude: ["includeTombstoned", "limit"] }),
    mount: Flags.string({ description: "Only this mount" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Export);
    const { json: _json, cwd, mount, ...rest } = flags;
    const filter = inputFromFlags(RecordFilterSchema, rest);
    const { ynm } = await this.open({ cwd });
    process.stdout.write(await ynm.exportJsonl({ ...filter, includeTombstoned: true, mount }));
  }
}
