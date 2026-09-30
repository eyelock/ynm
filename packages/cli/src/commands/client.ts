import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Args, Flags } from "@oclif/core";
import {
  applyChanges,
  type Change,
  CLIENT_ADAPTERS,
  changeIsNoop,
  changeTarget,
  clientAdapter,
  clientReports,
  formatClientReport,
  harnessManifestPath,
  loadConfig,
  ynmHome,
} from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

function run(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, { stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${argv.join(" ")} exited ${code}`))
    );
    child.on("error", reject);
  });
}

export default class Client extends YnmCommand {
  static override description =
    "Install or inspect ynm in an agent client (claude-code, copilot-cli, opencode, pi, ynh)";
  static override examples = [
    "<%= config.bin %> <%= command.id %> install claude-code",
    "<%= config.bin %> <%= command.id %> install claude-code --scope user",
    "<%= config.bin %> <%= command.id %> install claude-code --no-hooks",
    "<%= config.bin %> <%= command.id %> install copilot-cli --http https://memory.example.com/mcp --token $TOKEN",
    "<%= config.bin %> <%= command.id %> install opencode",
    "<%= config.bin %> <%= command.id %> install pi --scope user",
    "<%= config.bin %> <%= command.id %> install ynh",
    "<%= config.bin %> <%= command.id %> status",
  ];
  static override args = {
    action: Args.string({
      required: true,
      options: ["install", "status", "plan"],
      description: "install, plan or status",
    }),
    name: Args.string({
      description:
        "Client name; omitted: ynh in a harness directory, else every client this project uses",
      options: CLIENT_ADAPTERS.map((c) => c.name),
    }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    scope: Flags.string({
      description: "Install scope",
      options: ["project", "user"],
      default: "project",
    }),
    http: Flags.string({ description: "Use a hosted server at this URL instead of stdio" }),
    token: Flags.string({ description: "Bearer token for --http" }),
    yes: Flags.boolean({ description: "Run command changes without asking", default: false }),
    hooks: Flags.boolean({
      description: "Install the client's agent hooks (--no-hooks skips them)",
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Client);
    const cwd = flags.cwd ?? process.cwd();
    const home = ynmHome();
    void loadConfig({ home });
    if (args.action === "status") {
      const reports = await clientReports({ cwd, home: process.env.HOME ?? home });
      this.emit(flags.json, reports, () => reports.map(formatClientReport).join("\n"));
      return;
    }
    const userHome = process.env.HOME ?? home;
    const names = args.name ? [args.name] : await this.inferClients(cwd, userHome);
    const transport = flags.http
      ? { kind: "http" as const, url: flags.http, bearer: flags.token }
      : { kind: "stdio" as const, command: "ynm", args: ["serve"] };
    const results: Array<{ client: string; plan: Change[]; done: string[]; inPlace: string[] }> =
      [];
    for (const name of names) {
      const adapter = clientAdapter(name);
      // A change that would leave its file as it is (already installed) is not shown or applied.
      const plan = (
        await adapter.plan({
          cwd,
          home: userHome,
          scope: flags.scope as "project" | "user",
          transport,
          hooks: flags.hooks,
        })
      ).filter((c) => !changeIsNoop(c));
      const done =
        args.action === "plan"
          ? []
          : await applyChanges(plan, { runCommand: flags.yes ? run : undefined });
      // Nothing to change: say what was checked and where it was found, not just "nothing to do".
      const status = plan.length ? undefined : await adapter.status({ cwd, home: userHome });
      const inPlace = status
        ? [
            `already in place, nothing changed:`,
            ...(status.checked ?? [status.detail]).map((l) => `  ${l}`),
          ]
        : [];
      results.push({ client: adapter.name, plan, done, inPlace });
    }
    const heading = (client: string) => (names.length > 1 || !args.name ? [`${client}:`] : []);
    if (args.action === "plan") {
      this.emit(flags.json, names.length === 1 ? results[0]?.plan : results, () =>
        results
          .flatMap((r) => [
            ...heading(r.client),
            ...(r.plan.map((c) => `${c.kind.padEnd(10)} ${changeTarget(c)}  (${c.reason})`) || []),
            ...(r.plan.length ? [] : r.inPlace),
          ])
          .join("\n")
      );
      return;
    }
    this.emit(
      flags.json,
      names.length === 1 ? { client: results[0]?.client, done: results[0]?.done } : results,
      () =>
        results
          .flatMap((r) => [...heading(r.client), ...(r.done.length ? r.done : r.inPlace)])
          .join("\n")
    );
  }

  /**
   * No client named: a ynh harness directory means ynh; otherwise every client this project
   * already uses (its own config files), the same rule `ynm init` follows.
   */
  private async inferClients(cwd: string, home: string): Promise<string[]> {
    if (existsSync(harnessManifestPath(cwd))) return ["ynh"];
    const used: string[] = [];
    for (const a of CLIENT_ADAPTERS) {
      if (a.name === "ynh") continue;
      const d = await a.detect({ cwd, home });
      if (d.installed && d.signals?.project) used.push(a.name);
    }
    if (!used.length)
      this.error(
        `no agent client is configured in ${cwd}; name one: ynm client install <${CLIENT_ADAPTERS.map((c) => c.name).join("|")}>`,
        { exit: 2 }
      );
    return used;
  }
}
