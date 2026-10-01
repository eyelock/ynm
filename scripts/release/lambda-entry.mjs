// Entry point of the Lambda bundle (scripts/release/build-lambda.mjs), never run unbundled.
// The guidance markdown the MCP prompts serve is embedded here, as the CLI bundle does, because
// the function has no package tree to read it from.
//
// The s3 provider is imported first and statically. The service loads it with a dynamic
// import(), which makes esbuild defer initialising everything that path reaches, zod included;
// the MCP SDK's own top-level code then calls zod before it is set up ("ZodLazy is not a
// constructor"). A function always mounts an s3 store anyway, so load it up front.
import "../../packages/store-s3/dist/index.js";
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
