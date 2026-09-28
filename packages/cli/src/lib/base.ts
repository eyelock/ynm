import { Command, Flags } from "@oclif/core";
import { openYnm, RedactionError } from "@ynm/service";

/** Shared behaviour: --json everywhere, one way to open the service, uniform errors. */
export abstract class YnmCommand extends Command {
  static baseFlags = {
    json: Flags.boolean({ description: "Output as JSON", default: false }),
    cwd: Flags.string({ description: "Run as if from this directory", helpGroup: "GLOBAL" }),
  };

  protected async open(flags: { cwd?: string }) {
    return openYnm({ cwd: flags.cwd });
  }

  protected emit(json: boolean, value: unknown, human: () => string): void {
    this.log(json ? JSON.stringify(value, null, 2) : human());
  }

  protected override async catch(err: Error & { exitCode?: number }): Promise<unknown> {
    if (err instanceof RedactionError) this.error(`refused: ${err.message}`, { exit: 2 });
    if (err.name === "ZodError") this.error(`invalid input: ${err.message}`, { exit: 2 });
    return super.catch(err);
  }
}
