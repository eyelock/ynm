import { Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Reindex extends YnmCommand {
  static override description = "Rebuild the search index from the log";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --mount project",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Only this mount" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Reindex);
    const { ynm } = await this.open(flags);
    const counts = await ynm.reindex(flags.mount);
    this.emit(flags.json, counts, () =>
      Object.entries(counts)
        .map(([m, n]) => `${m}: ${n} memories indexed`)
        .join("\n")
    );
  }
}
