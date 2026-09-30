import { spawn } from "node:child_process";
import { Args, Flags } from "@oclif/core";
import {
  applyChanges,
  CLIENT_ADAPTERS,
  type ClientStatus,
  clientAdapter,
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
    name: Args.string({ description: "Client name", options: CLIENT_ADAPTERS.map((c) => c.name) }),
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
      const statuses: ClientStatus[] = [];
      for (const a of CLIENT_ADAPTERS)
        statuses.push(await a.status({ cwd, home: process.env.HOME ?? home }));
      this.emit(flags.json, statuses, () =>
        statuses.map((s) => `${s.configured ? "ok  " : "--  "} ${s.client}: ${s.detail}`).join("\n")
      );
      return;
    }
    if (!args.name) this.error("client name required", { exit: 2 });
    const adapter = clientAdapter(args.name);
    const transport = flags.http
      ? { kind: "http" as const, url: flags.http, bearer: flags.token }
      : { kind: "stdio" as const, command: "ynm", args: ["serve"] };
    const plan = await adapter.plan({
      cwd,
      home: process.env.HOME ?? home,
      scope: flags.scope as "project" | "user",
      transport,
      hooks: flags.hooks,
    });
    if (args.action === "plan") {
      this.emit(
        flags.json,
        plan,
        () =>
          plan
            .map(
              (c) =>
                `${c.kind.padEnd(10)} ${c.kind === "command" ? c.argv.join(" ") : c.path}  (${c.reason})`
            )
            .join("\n") || "nothing to do"
      );
      return;
    }
    const done = await applyChanges(plan, { runCommand: flags.yes ? run : undefined });
    this.emit(flags.json, { client: adapter.name, done }, () => done.join("\n") || "nothing to do");
  }
}
