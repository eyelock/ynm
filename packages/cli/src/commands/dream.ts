import { ConsolidateInputSchema } from "@ynm/model";
import { Lifecycle } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Dream extends YnmCommand {
  static override description =
    "Run consolidation passes: expire, promote, dedupe, contradict, reflect, normalise. Judged by the configured Judge; uncalibrated judges flag for review instead of acting.";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --dry-run --json",
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(ConsolidateInputSchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dream);
    const { json, cwd, ...rest } = flags;
    const input = inputFromFlags(ConsolidateInputSchema, rest);
    const { ynm } = await this.open({ cwd });
    const report = await new Lifecycle(ynm).consolidate(input);
    this.emit(
      json,
      report,
      () =>
        Object.entries(report.passes)
          .map(
            ([name, p]) =>
              `${name}: ${p.changed.length}/${p.candidates} ${report.dryRun ? "would change" : "changed"}`
          )
          .join("\n") || "no passes ran"
    );
  }
}
