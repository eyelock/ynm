import { doctor } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Doctor extends YnmCommand {
  static override description = "Check configuration, mounts, refspecs and hooks";
  static override examples = ["<%= config.bin %> <%= command.id %>"];
  static override flags = { ...YnmCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const ctx = await this.open(flags);
    const report = await doctor(ctx);
    this.emit(flags.json, report, () =>
      report.checks
        .map(
          (c) => `${c.ok ? "ok  " : c.level === "warn" ? "warn" : "FAIL"}  ${c.name}: ${c.detail}`
        )
        .join("\n")
    );
    if (!report.ok) this.exit(1);
  }
}
