import { resolve } from "node:path";
import { Args } from "@oclif/core";
import { projectClients, validateClient, ynmHome } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Validate extends YnmCommand {
  static override description =
    "Check ynm's setup for the agent clients in a directory and print every check: a ynh harness, or the clients a project uses";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> ~/my-harness",
  ];
  static override args = {
    dir: Args.string({ description: "Directory to check (default: the current directory)" }),
  };
  static override flags = { ...YnmCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Validate);
    const cwd = resolve(args.dir ?? flags.cwd ?? process.cwd());
    const home = process.env.HOME ?? ynmHome();
    const names = await projectClients(cwd, home);
    if (!names.length)
      this.error(
        `nothing to validate in ${cwd}: no ynh harness and no agent client configured here`,
        {
          exit: 1,
        }
      );
    const results: Awaited<ReturnType<typeof validateClient>>[] = [];
    for (const n of names) results.push(await validateClient(n, cwd, home));
    const ok = results.every((r) => r.ok);
    this.emit(flags.json, { ok, clients: results }, () =>
      [
        ...results.flatMap((r) => [
          `${r.client}: ${r.ok ? "valid" : "problems found"}`,
          ...r.lines.map((l) => `  ${l.ok ? "ok  " : "FAIL"}  ${l.what.padEnd(8)}  ${l.detail}`),
        ]),
      ].join("\n")
    );
    if (!ok) this.exit(1);
  }
}
