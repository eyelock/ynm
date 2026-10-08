import { Flags } from "@oclif/core";
import { RememberInputSchema } from "@ynm/model";
import { similarGuidance, similarMemories } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Remember extends YnmCommand {
  static override description =
    "Record a memory; a note names similar memories already stored, so a repeated fact can be superseded instead";
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
    // A hint only: a similar memory never stops the write or changes the exit code.
    const similar = await similarMemories(ynm, input.content, r.memoryId);
    const note = similarGuidance(similar, "`ynm supersede`");
    this.emit(json, note ? { ...r, guidance: note } : r, () =>
      [`remembered ${r.memoryId} in ${r.mount}`, ...(note ? [`note: ${note}`] : [])].join("\n")
    );
  }
}
