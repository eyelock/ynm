// Entry point of the Lambda bundle (scripts/release/build-lambda.mjs), never run unbundled.
// The guidance markdown the MCP prompts serve is embedded here, as the CLI bundle does, because
// the function has no package tree to read it from.
import { embedGuidance } from "../../packages/model/dist/guidance/index.js";
import sessionStart from "../../packages/model/src/guidance/session-start.md";
import whenToPromote from "../../packages/model/src/guidance/when-to-promote.md";
import whenToRemember from "../../packages/model/src/guidance/when-to-remember.md";

embedGuidance({
  "session-start": sessionStart,
  "when-to-remember": whenToRemember,
  "when-to-promote": whenToPromote,
});

export { handler } from "../../packages/mcp/dist/lambda.js";
