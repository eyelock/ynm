import { readFileSync } from "node:fs";
import { Args, Flags } from "@oclif/core";
import { buildWiki, ingestWikiPage } from "@ynm/service";
import { YnmCommand } from "../lib/base.js";

export default class Wiki extends YnmCommand {
  static override description =
    "Build the markdown projection (index, log, memories, entities, topics) or ingest an edited page";
  static override examples = [
    "<%= config.bin %> <%= command.id %> build",
    "<%= config.bin %> <%= command.id %> build --target orphan-branch --mount project",
    "<%= config.bin %> <%= command.id %> ingest .ynm/wiki/memories/01J....md",
  ];
  static override args = {
    action: Args.string({
      ignoreStdin: true,
      required: true,
      options: ["build", "ingest"],
      description: "build or ingest",
    }),
    file: Args.string({ ignoreStdin: true, description: "Edited memory page (for ingest)" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Only this mount" }),
    target: Flags.string({
      description: "Where to write",
      options: ["directory", "orphan-branch"],
      default: "directory",
    }),
    dir: Flags.string({ description: "Directory for the directory target" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Wiki);
    const ctx = await this.open(flags);
    if (args.action === "ingest") {
      if (!args.file) this.error("file required", { exit: 2 });
      const r = await ingestWikiPage(ctx.ynm, readFileSync(args.file, "utf8"));
      this.emit(flags.json, r, () =>
        r.changed ? `superseded ${r.memoryId} from the edited page` : `no change for ${r.memoryId}`
      );
      return;
    }
    const res = await buildWiki(ctx.ynm, {
      mount: flags.mount,
      target: flags.target as "directory" | "orphan-branch",
      dir: flags.dir,
      home: ctx.loaded.home,
      repo: ctx.worktree.isGitRepo ? ctx.worktree.mainRepoPath : undefined,
    });
    this.emit(flags.json, res, () =>
      res.map((r) => `${r.mount}: ${r.written} pages -> ${r.location}`).join("\n")
    );
  }
}
