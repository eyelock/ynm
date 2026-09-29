import { InMemoryIndex } from "./memory-index.js";
import { runIndexConformance } from "./testing/conformance.js";

runIndexConformance("memory", async () => new InMemoryIndex());
