import { Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Sync extends YnmCommand {
  static override description =
    "Fetch, merge and push shared memory (never personal unless --mount personal)";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --dry-run",
    "<%= config.bin %> <%= command.id %> --mount personal --remote backup",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    remote: Flags.string({ description: "Remote name (default from config)" }),
    push: Flags.boolean({ description: "Push after merging", default: true, allowNo: true }),
    pull: Flags.boolean({ description: "Fetch and merge first", default: true, allowNo: true }),
    "dry-run": Flags.boolean({ description: "Report what would change", default: false }),
    mount: Flags.string({ description: "Only this mount (required to sync personal)" }),
    quiet: Flags.boolean({ description: "No output unless something fails", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Sync);
    if (flags.mount === "personal" && !flags.remote)
      this.error("syncing the personal store needs an explicit --remote (ADR-007)", { exit: 2 });
    const { ynm } = await this.open(flags);
    const results = await ynm.sync({
      remote: flags.remote,
      push: flags.push,
      pull: flags.pull,
      dryRun: flags["dry-run"],
      mount: flags.mount,
    });
    const failed = Object.values(results).some((r) => r.conflicts.length);
    if (flags.quiet && !failed) return;
    this.emit(flags.json, results, () =>
      Object.entries(results).length
        ? Object.entries(results)
            .map(
              ([id, r]) =>
                `${id}: fetched ${r.fetched}, merged ${r.merged.length}, pushed ${r.pushed.length}, retries ${r.retries}${r.conflicts.length ? `, conflicts: ${r.conflicts.join("; ")}` : ""}`
            )
            .join("\n")
        : "nothing to sync (no replicating distributed mount)"
    );
    if (failed) this.exit(1);
  }
}
