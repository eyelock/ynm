import { YnmCommand } from "../lib/base.js";

export default class Status extends YnmCommand {
  static override description = "Show mounts and configuration";
  static override examples = [
    "<%= config.bin %> <%= command.id %>",
    "<%= config.bin %> <%= command.id %> --json",
  ];
  static override flags = { ...YnmCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(Status);
    const { ynm, loaded, worktree } = await this.open(flags);
    const status = await ynm.status();
    const index = await ynm.indexStatus();
    const value = {
      name: "ynm",
      version: this.config.version,
      milestone: "M2",
      config: loaded.files,
      repo: worktree.isGitRepo ? worktree.mainRepoPath : null,
      ...status,
      index,
    };
    this.emit(flags.json, value, () =>
      [
        `ynm ${this.config.version}`,
        `config: ${loaded.files.join(", ") || "defaults"}`,
        ...status.mounts.map((m) => {
          const ix = index.find((i) => i.mount === m.id);
          const ixText = ix ? `index ${ix.fresh ? "fresh" : "stale"} (${ix.indexed})` : "";
          return `  ${m.id.padEnd(10)} ${m.level.padEnd(12)} ${m.provider.padEnd(10)} ${m.shards} shard(s)  ${ixText}  ${m.location}`;
        }),
        ...(status.mounts.length ? [] : ["  no mounts"]),
      ].join("\n")
    );
  }
}
