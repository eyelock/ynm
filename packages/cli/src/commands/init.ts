import { Flags } from "@oclif/core";
import { initBare, initPersonal, initProject, loadConfig, ynmHome } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Init extends YnmCommand {
  static override description =
    "Set up memory for this repository, your personal store, or a dedicated bare repo";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --personal",
    "<%= config.bin %> <%= command.id %> --bare /srv/memory.git",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    personal: Flags.boolean({ description: "Create the personal store only", default: false }),
    bare: Flags.string({
      description: "Create or adopt a dedicated bare memory repo at this path",
    }),
    remote: Flags.string({ description: "Remote for the shared fetch refspec", default: "origin" }),
    hooks: Flags.boolean({
      description: "Install the pre-push hook",
      default: true,
      allowNo: true,
    }),
    anchor: Flags.string({ description: "Anchor commit sha (needed on shallow clones)" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    if (flags.bare) {
      const r = await initBare(flags.bare);
      this.emit(
        flags.json,
        r,
        () =>
          `${r.created ? "created" : "adopted"} bare memory repo ${r.repo} (anchor ${r.anchor.slice(0, 12)})`
      );
      return;
    }
    if (flags.personal) {
      const { config } = loadConfig({ home: ynmHome() });
      const r = await initPersonal(config.personalStore as string);
      this.emit(
        flags.json,
        r,
        () => `personal store ${r.created ? "created" : "ready"} at ${r.repo}`
      );
      return;
    }
    const report = await initProject({
      cwd: flags.cwd ?? process.cwd(),
      remote: flags.remote,
      hooks: flags.hooks,
      anchor: flags.anchor,
    });
    this.emit(flags.json, report, () =>
      [
        `initialised ${report.repo}`,
        `  anchor    ${report.anchor} (${report.anchorSource})`,
        `  config    ${report.configFile}${report.configWritten ? "" : " (unchanged)"}`,
        ...(report.refspecs.length
          ? [`  refspecs  ${report.refspecs.join("\n            ")}`]
          : []),
        ...(report.hooksInstalled.length
          ? [`  hooks     ${report.hooksInstalled.join(", ")}`]
          : []),
        ...report.notes.map((n) => `  note      ${n}`),
        'next: `ynm remember --type semantic --content "..."` and `ynm doctor`',
      ].join("\n")
    );
  }
}
