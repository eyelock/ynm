import { Flags } from "@oclif/core";
import { main as serveMcp } from "@ynm/mcp";
import { YnmCommand } from "../lib/base.js";

/**
 * One binary does everything: `ynm serve` is the MCP server over stdio (what clients launch),
 * `ynm serve --http` the hosted service. Delegates to @ynm/mcp's entry so the flags stay one set.
 */
export default class Serve extends YnmCommand {
  static override description =
    "Start the MCP server (stdio by default, --http for the hosted service)";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --http --port 3000 --no-personal --cwd /srv/memory.git",
    "<%= config.bin %> <%= command.id %> --http --dream-every 15m --sync-every 5m",
  ];
  static override flags = {
    cwd: YnmCommand.baseFlags.cwd,
    http: Flags.boolean({ description: "Streamable HTTP instead of stdio", default: false }),
    port: Flags.integer({ description: "HTTP port (default 3000, or $PORT)" }),
    host: Flags.string({
      description: "HTTP bind host (default localhost; 0.0.0.0 in containers)",
    }),
    token: Flags.string({
      description:
        "Static bearer token (dev); production uses YNM_JWKS_URL or YNM_OAUTH_INTROSPECTION_URL",
    }),
    "allow-origin": Flags.string({ description: "Comma-separated allowed origins" }),
    "allow-host": Flags.string({
      description: "Comma-separated allowed Host headers (* behind a proxy)",
    }),
    "no-personal": Flags.boolean({
      description: "Mount no personal store (hosted servers)",
      default: false,
    }),
    "dream-every": Flags.string({ description: "Run consolidation on this interval (e.g. 15m)" }),
    "sync-every": Flags.string({ description: "Run sync on this interval (e.g. 5m)" }),
    "modern-only": Flags.boolean({
      description: "Reject legacy protocol versions",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Serve);
    const argv: string[] = [];
    if (flags.http) argv.push("--http");
    else argv.push("--stdio");
    if (flags.cwd) argv.push("--cwd", flags.cwd);
    if (flags.port !== undefined) argv.push("--port", String(flags.port));
    if (flags.host) argv.push("--host", flags.host);
    if (flags.token) argv.push("--token", flags.token);
    if (flags["allow-origin"]) argv.push("--allow-origin", flags["allow-origin"]);
    if (flags["allow-host"]) argv.push("--allow-host", flags["allow-host"]);
    if (flags["no-personal"]) argv.push("--no-personal");
    if (flags["dream-every"]) argv.push("--dream-every", flags["dream-every"]);
    if (flags["sync-every"]) argv.push("--sync-every", flags["sync-every"]);
    if (flags["modern-only"]) argv.push("--modern-only");
    await serveMcp(argv);
  }
}
