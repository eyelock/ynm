import { Args } from "@oclif/core";
import { logoutRemote, ynmHome } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Logout extends YnmCommand {
  static override description =
    "Sign out of a hosted store: forgets this machine's sign-in and client registration for the mount";
  static override examples = ["<%= config.bin %> <%= command.id %> team"];
  static override args = {
    mount: Args.string({ ignoreStdin: true, required: true, description: "Mount id" }),
  };
  static override flags = { ...YnmCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logout);
    // By id alone, so a mount already removed from the config can still be signed out of.
    const signedOut = await logoutRemote({ home: ynmHome(process.env), mountId: args.mount });
    this.emit(flags.json, { mount: args.mount, signedOut }, () =>
      signedOut ? `signed out of ${args.mount}` : `not signed in to ${args.mount}`
    );
  }
}
