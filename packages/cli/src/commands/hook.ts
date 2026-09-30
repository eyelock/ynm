import { Args, Command, Flags } from "@oclif/core";
import { HOOK_EVENTS } from "@ynm/service/hook-intent";
import { runHook } from "../lib/hook.js";

export default class Hook extends Command {
  static override description =
    "Answer an agent client's hook: read its hook JSON on stdin, print the reply JSON on stdout (session-start, prompt, stop)";
  static override examples = [
    `echo '{"session_id":"abc","cwd":"."}' | <%= config.bin %> <%= command.id %> session-start`,
    `echo '{"prompt":"remember I prefer tabs"}' | <%= config.bin %> <%= command.id %> prompt`,
    "<%= config.bin %> <%= command.id %> stop < /dev/null",
  ];
  static override args = {
    event: Args.string({ description: `Hook event: ${HOOK_EVENTS.join(", ")}` }),
  };
  static override flags = {
    cwd: Flags.string({
      description: "Run as if from this directory (default: the hook's cwd, then the process cwd)",
      helpGroup: "GLOBAL",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Hook);
    await runHook(args.event, flags.cwd);
  }

  /** A hook never fails the session: even a flag oclif rejects ends as `{}`, exit 0. */
  protected override async catch(err: Error): Promise<unknown> {
    process.stderr.write(`ynm hook: ${err.message}\n`);
    process.stdout.write("{}\n");
    return undefined;
  }
}
