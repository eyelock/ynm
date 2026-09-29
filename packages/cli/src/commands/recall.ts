import { RecallQuerySchema } from "@ynm/model";
import { YnmCommand } from "../lib/base.js";
import { flagsFromSchema, inputFromFlags } from "../lib/flags.js";

export default class Recall extends YnmCommand {
  static override description =
    "Search memory: indexed, ranked by relevance, recency and importance";
  static override examples = [
    '<%= config.bin %> <%= command.id %> --text "how do we release"',
    "<%= config.bin %> <%= command.id %> --type procedural --level distributed --explain --json",
  ];
  static override flags = { ...YnmCommand.baseFlags, ...flagsFromSchema(RecallQuerySchema) };

  async run(): Promise<void> {
    const { flags } = await this.parse(Recall);
    const { json, cwd, ...rest } = flags;
    const q = inputFromFlags(RecallQuerySchema, rest);
    const { ynm } = await this.open({ cwd });
    const hits = await ynm.recall(q);
    this.emit(json, hits, () =>
      hits.length
        ? hits
            .map(
              (h) =>
                `${h.score.toFixed(3)}  ${h.memoryId}  ${h.type.padEnd(10)} ${h.mount.padEnd(9)} ${h.pinned ? "* " : ""}${h.summary}${
                  h.explain
                    ? `\n        rel ${h.explain.relevance.toFixed(2)} rec ${h.explain.recency.toFixed(2)} imp ${h.explain.importance.toFixed(2)}`
                    : ""
                }`
            )
            .join("\n")
        : "no matches"
    );
  }
}
