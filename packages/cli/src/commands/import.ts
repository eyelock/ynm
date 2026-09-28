import { readFileSync } from "node:fs";
import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

export default class Import extends YnmCommand {
  static override description = "Import JSONL records (from a file or stdin), routed by level";
  static override examples = [
    "<%= config.bin %> <%= command.id %> memory.jsonl",
    "cat memory.jsonl | <%= config.bin %> <%= command.id %>",
  ];
  static override args = { file: Args.string({ description: "JSONL file; omit to read stdin" }) };
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Force a target mount" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Import);
    const text = args.file ? readFileSync(args.file, "utf8") : readFileSync(0, "utf8");
    const { ynm } = await this.open(flags);
    const r = await ynm.importJsonl(text, flags.mount);
    this.emit(
      flags.json,
      r,
      () =>
        `imported ${r.imported} record(s)${r.problems.length ? `; skipped ${r.problems.length}: ${r.problems.join("; ")}` : ""}`
    );
  }
}
