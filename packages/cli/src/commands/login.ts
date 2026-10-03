import { Args } from "@oclif/core";
import { detectWorktree, loadConfig, loadEnvFile, loginRemote, ynmHome } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

/** The url of remote mount `id`, from the same config layers every command reads. */
async function remoteMountUrl(id: string, cwd: string | undefined): Promise<string | undefined> {
  const env = process.env;
  const home = ynmHome(env);
  loadEnvFile(home, env);
  const worktree = await detectWorktree(cwd ?? process.cwd());
  const { config } = loadConfig(
    {
      home,
      repo: worktree.isGitRepo ? worktree.mainRepoPath : undefined,
      worktree: worktree.isGitRepo ? worktree.currentPath : undefined,
    },
    env
  );
  // Read loosely: only a mount with this id and a url string is a remote one.
  const mount = (config.mounts ?? []).find((m) => m.id === id) as { url?: unknown } | undefined;
  return typeof mount?.url === "string" ? mount.url : undefined;
}

export default class Login extends YnmCommand {
  static override description =
    "Sign in to a hosted store mounted on this machine: opens the browser at its identity provider and keeps the sign-in for this mount";
  static override examples = ["<%= config.bin %> <%= command.id %> team"];
  static override args = {
    mount: Args.string({ ignoreStdin: true, required: true, description: "Mount id" }),
  };
  static override flags = { ...YnmCommand.baseFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Login);
    // No this.open: signing in must work even when the hosted store cannot be read yet.
    const url = await remoteMountUrl(args.mount, flags.cwd);
    if (!url)
      this.error(
        `no remote mount "${args.mount}": add {"id":"${args.mount}","level":"distributed","provider":"mcp","url":"…"} to mounts in ~/.ynm/config.json`,
        { exit: 2 }
      );
    let scopes: string | undefined;
    try {
      ({ scopes } = await loginRemote({ home: ynmHome(process.env), mountId: args.mount, url }));
    } catch (err) {
      // fetch hides the reason (refused, unknown host) in `cause`.
      const e = err as Error & { cause?: { message?: string } };
      const reason = e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
      this.error(`could not sign in to ${args.mount} (${url}): ${reason}`, { exit: 1 });
    }
    this.emit(
      flags.json,
      { mount: args.mount, url, signedIn: true, scopes },
      () => `signed in to ${args.mount} (${url})`
    );
  }
}
