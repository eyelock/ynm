import { ConsolidateInputSchema } from "@ynm/model";
import { Lifecycle } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

/** Passes that ask the model; a dry run without --judge only counts their candidates. */
const MODEL_PASSES = new Set(["promote", "dedupe", "contradict", "reflect"]);

export default class Dream extends YnmCommand {
  static override description =
    "Run consolidation passes: expire, promote, dedupe, contradict, reflect, normalise. Judged by the configured Judge; uncalibrated judges flag for review instead of acting. --dry-run calls no model and lists each pass's candidates; add --judge to see the verdicts.";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --dry-run --json",
    "<%= config.bin %> <%= command.id %> --dry-run --judge",
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
        [
          ...Object.entries(report.passes).map(([name, p]) =>
            report.full && !report.full.judged && MODEL_PASSES.has(name) && p.candidates > 0
              ? `${name}: ${p.candidates} candidates (not judged; add --judge)${
                  p.changed.length ? `, ${p.changed.length} would change` : ""
                }`
              : `${name}: ${p.changed.length}/${p.candidates} ${report.dryRun ? "would change" : "changed"}`
          ),
          ...(report.full?.fresh === 0 ? ["nothing new since the last run; only expiry ran"] : []),
        ].join("\n") || "no passes ran"
    );
  }
}
