import { HeuristicJudge } from "./judges/heuristic.js";
import { TypeSafeJudge } from "./judges/typesafe.js";
import { WriterEmulatedJudge } from "./judges/writer-emulated.js";
import type { Judge, Writer } from "./types.js";
import { ClaudeCliWriter } from "./writers/claude-cli.js";
import { NoneWriter } from "./writers/none.js";
import { OpenAICompatibleWriter } from "./writers/openai-compatible.js";

export type JudgeKind = "heuristic" | "typesafe" | "writer-emulated" | "auto";
export type WriterKind = "none" | "claude-cli" | "openai-compatible" | "auto";

export interface ModelsConfig {
  judge: JudgeKind;
  writer: WriterKind;
  typesafe?: { model?: string; apiKeyEnv?: string };
  openai?: { baseUrl?: string; model?: string; apiKeyEnv?: string };
  claude?: { model?: string };
}

export const DEFAULT_MODELS_CONFIG: ModelsConfig = {
  judge: "auto",
  writer: "auto",
  typesafe: { apiKeyEnv: "TYPESAFE_API_KEY" },
  openai: {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:latest",
    apiKeyEnv: "OPENAI_API_KEY",
  },
};

export interface Models {
  judge: Judge;
  writer: Writer;
  /** How each was chosen, for status and evals. */
  resolution: { judge: string; writer: string };
}

/**
 * Resolves the seams from config and environment (ADR-012). `auto` prefers TypeSafe for the
 * judge when a key is present, else emulates over the writer when one exists, else heuristic.
 */
export function resolveModels(
  cfg: ModelsConfig = DEFAULT_MODELS_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
  probes: { claudeCli?: boolean } = {}
): Models {
  const c = {
    ...DEFAULT_MODELS_CONFIG,
    ...cfg,
    typesafe: { ...DEFAULT_MODELS_CONFIG.typesafe, ...cfg.typesafe },
    openai: { ...DEFAULT_MODELS_CONFIG.openai, ...cfg.openai },
  };
  let writer: Writer;
  let writerWhy: string;
  const openaiKey = c.openai.apiKeyEnv ? env[c.openai.apiKeyEnv] : undefined;
  switch (c.writer) {
    case "none":
      writer = new NoneWriter();
      writerWhy = "configured none";
      break;
    case "claude-cli":
      writer = new ClaudeCliWriter(c.claude);
      writerWhy = "configured claude-cli";
      break;
    case "openai-compatible":
      writer = new OpenAICompatibleWriter({
        baseUrl: c.openai.baseUrl as string,
        model: c.openai.model as string,
        apiKey: openaiKey,
      });
      writerWhy = `configured openai-compatible (${c.openai.baseUrl})`;
      break;
    default:
      if (probes.claudeCli) {
        writer = new ClaudeCliWriter(c.claude);
        writerWhy = "auto: claude CLI available";
      } else if (openaiKey || env.YNM_OPENAI_BASE_URL) {
        writer = new OpenAICompatibleWriter({
          baseUrl: env.YNM_OPENAI_BASE_URL ?? (c.openai.baseUrl as string),
          model: env.YNM_OPENAI_MODEL ?? (c.openai.model as string),
          apiKey: openaiKey,
        });
        writerWhy = "auto: openai-compatible endpoint configured";
      } else {
        writer = new NoneWriter();
        writerWhy = "auto: no writer available";
      }
  }
  const typesafeKey = c.typesafe.apiKeyEnv ? env[c.typesafe.apiKeyEnv] : undefined;
  let judge: Judge;
  let judgeWhy: string;
  switch (c.judge) {
    case "heuristic":
      judge = new HeuristicJudge();
      judgeWhy = "configured heuristic";
      break;
    case "typesafe":
      judge = new TypeSafeJudge({ apiKey: typesafeKey ?? "", model: c.typesafe.model });
      judgeWhy = "configured typesafe";
      break;
    case "writer-emulated":
      judge = new WriterEmulatedJudge(writer);
      judgeWhy = `configured writer-emulated over ${writer.name}`;
      break;
    default:
      if (typesafeKey) {
        judge = new TypeSafeJudge({ apiKey: typesafeKey, model: c.typesafe.model });
        judgeWhy = "auto: TYPESAFE_API_KEY present";
      } else if (writer.name !== "none") {
        judge = new WriterEmulatedJudge(writer);
        judgeWhy = `auto: emulated over ${writer.name} (uncalibrated)`;
      } else {
        judge = new HeuristicJudge();
        judgeWhy = "auto: no model available";
      }
  }
  return { judge, writer, resolution: { judge: judgeWhy, writer: writerWhy } };
}
