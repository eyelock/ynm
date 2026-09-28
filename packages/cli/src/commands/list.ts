import { Flags } from "@oclif/core";
import { RecordFilterSchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class List extends YnmCommand {
  static override description = "List memories (folded, newest first) across mounts";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --type procedural --level distributed --json",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    ...flagsFromSchema(RecordFilterSchema),
    mount: Flags.string({ description: "Only this mount" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(List);
    const { json, cwd, mount, ...rest } = flags;
    const filter = inputFromFlags(RecordFilterSchema, rest);
    const { ynm } = await this.open({ cwd });
    const memories = await ynm.list({ ...filter, mount });
    this.emit(json, memories, () =>
      memories.length
        ? memories
            .map(
              (m) =>
                `${m.memoryId}  ${m.type.padEnd(10)} ${m.level.padEnd(11)} ${m.namespace.padEnd(24)} ${m.pinned ? "* " : ""}${m.current.summary ?? ""}`
            )
            .join("\n")
        : "no memories"
    );
  }
}
