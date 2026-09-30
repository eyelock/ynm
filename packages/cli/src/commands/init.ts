import { homedir } from "node:os";
import { Flags } from "@oclif/core";
import {
  CLIENT_ADAPTERS,
  initBare,
  initPersonal,
  initProject,
  loadConfig,
  ynmHome,
} from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Init extends YnmCommand {
  static override description =
    "Set up memory for this repository, your personal store, or a dedicated bare repo";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --no-clients",
    "<%= config.bin %> <%= command.id %> --client claude-code --client ynh",
    "<%= config.bin %> <%= command.id %> --personal",
    "<%= config.bin %> <%= command.id %> --bare /srv/memory.git",
  ];
  static override flags = {
    ...YnmCommand.baseFlags,
    personal: Flags.boolean({ description: "Create the personal store only", default: false }),
    bare: Flags.string({
      description: "Create or adopt a dedicated bare memory repo at this path",
    }),
    remote: Flags.string({
      description: "Remote for the distributed fetch refspec",
      default: "origin",
    }),
    hooks: Flags.boolean({
      description:
        "Install the pre-push hook (default: the `hooks` config key, which defaults to true)",
      allowNo: true,
    }),
    anchor: Flags.string({ description: "Anchor commit sha (needed on shallow clones)" }),
    clients: Flags.boolean({
      description:
        "Configure the agent clients this repository already uses (server, guidance, hooks); clients only on this machine are listed, not written; --no-clients skips it",
      default: true,
      allowNo: true,
    }),
    client: Flags.string({
      description:
        "Configure this client even if the repository does not use it yet (repeatable); only these",
      options: CLIENT_ADAPTERS.map((c) => c.name),
      multiple: true,
    }),
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
      clients: flags.clients
        ? { home: process.env.HOME ?? homedir(), only: flags.client }
        : undefined,
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
        ...report.clients
          .filter((c) => !c.skipped)
          .flatMap((c) => [
            `  client    ${c.client}: ${c.applied.length ? c.applied.join(", ") : "unchanged"}`,
            ...c.run.map((r) => `  run:      ${r}`),
          ]),
        ...(report.clients.some((c) => c.skipped)
          ? [
              `  also      ${report.clients
                .filter((c) => c.skipped)
                .map((c) => c.client)
                .join(
                  ", "
                )} on this machine but not used here; add one with \`ynm client install <name>\``,
            ]
          : []),
        ...(report.commit.length
          ? [
              `  commit    ${report.commit.join(" ")}`,
              "            the team shares these; commit them so every clone gets the same setup",
            ]
          : []),
        ...(report.local.length
          ? [`  local     ${report.local.join(" ")} (yours only; excluded from git)`]
          : []),
        "  memory    lives in git notes, not in files; `ynm sync` and the pre-push hook share it",
        'next: `ynm remember --type semantic --content "..."` and `ynm doctor`',
      ].join("\n")
    );
  }
}
