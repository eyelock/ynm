import { readFileSync } from "node:fs";
import { Args, Flags } from "@oclif/core";
import { YnmCommand } from "../lib/base.js";

/** Reads stdin to its end, however slowly the producer writes. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export default class Import extends YnmCommand {
  static override description = "Import JSONL records (from a file or stdin), routed by level";
  static override examples = [
    "<%= config.bin %> <%= command.id %> memory.jsonl",
    "cat memory.jsonl | <%= config.bin %> <%= command.id %>",
  ];
  // ignoreStdin: oclif would otherwise read piped JSONL into `file` and treat it as a path.
  static override args = {
    file: Args.string({ ignoreStdin: true, description: "JSONL file; omit to read stdin" }),
  };
  static override flags = {
    ...YnmCommand.baseFlags,
    mount: Flags.string({ description: "Force a target mount" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Import);
    const text = args.file ? readFileSync(args.file, "utf8") : await readAllStdin();
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
