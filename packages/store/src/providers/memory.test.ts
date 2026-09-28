import { runRecordLogConformance } from "../testing/conformance.js";
import { MemoryLog } from "./memory.js";

runRecordLogConformance("memory", {
  create: async (level) => new MemoryLog(`mem-${level}`, level),
});
