import { Command, Flags } from "@oclif/core";

/** Reports what ynm knows about this environment. Grows with each milestone. */
export default class Status extends Command {
  static override description = "Show ynm status";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --json",
  ];
  static override flags = {
    json: Flags.boolean({ description: "Output as JSON", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Status);
    const status = {
      name: "ynm",
      version: this.config.version,
      milestone: "M0",
      mounts: [] as string[],
    };
    if (flags.json) {
      this.log(JSON.stringify(status));
      return;
    }
    this.log(`ynm ${status.version} (milestone ${status.milestone}); no mounts configured`);
  }
}
