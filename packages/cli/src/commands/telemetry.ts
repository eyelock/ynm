import { Args, Flags } from "@oclif/core";
import { MCP_VERSION } from "@ynm/mcp";
import { REGISTRY } from "@ynm/telemetry";
import { YnmCommand } from "../lib/base.js";

/**
 * The names ynm's telemetry uses, so a collector can tell what each one means: the registry is
 * identified by the tool's name and version, which every record carries as `service.name` and
 * `service.version`.
 */
export default class Telemetry extends YnmCommand {
  static override description =
    "Print the telemetry registry: every attribute, event, span and metric ynm emits";
  static override examples = ["<%= config.bin %> <%= command.id %> registry --format json"];
  static override args = {
    action: Args.string({
      ignoreStdin: true,
      required: true,
      options: ["registry"],
      description: "registry: print the registry",
    }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    format: Flags.string({ description: "Output format", options: ["json"], default: "json" }),
  };

  async run(): Promise<void> {
    await this.parse(Telemetry);
    this.log(JSON.stringify({ tool: "ynm", version: MCP_VERSION, registry: REGISTRY }, null, 2));
  }
}
