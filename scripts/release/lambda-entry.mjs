// Entry point of the Lambda bundle (scripts/release/build-lambda.mjs), never run unbundled.
// The guidance markdown the MCP prompts serve is embedded here, as the CLI bundle does, because
// the function has no package tree to read it from.
//
// The s3 provider is imported first and statically. The service loads it with a dynamic
// import(), which makes esbuild defer initialising everything that path reaches, zod included;
// the MCP SDK's own top-level code then calls zod before it is set up ("ZodLazy is not a
// constructor"). A function always mounts an s3 store anyway, so load it up front.
import "../../packages/store-s3/dist/index.js";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { embedGuidance } from "../../packages/model/dist/guidance/index.js";
import sessionStart from "../../packages/model/src/guidance/session-start.md";
import whenToPromote from "../../packages/model/src/guidance/when-to-promote.md";
import whenToRemember from "../../packages/model/src/guidance/when-to-remember.md";

embedGuidance({
  "session-start": sessionStart,
  "when-to-remember": whenToRemember,
  "when-to-promote": whenToPromote,
});

// Secrets (a bearer token, a model API key) come from Parameter Store rather than the function's
// environment, so they never sit in its configuration or in Terraform state. With
// YNM_SSM_ENV_PATH=/ynm/acme/env/ every parameter under that path whose last segment is an
// environment variable name becomes that variable, unless it is already set; a value of "unset"
// (a placeholder nobody has filled in) is skipped. This runs during the cold start, before the
// handler module is loaded, because the handler reads its environment when it loads.
async function loadSsmEnv(env) {
  const raw = env.YNM_SSM_ENV_PATH?.trim();
  if (!raw) return;
  const path = raw.endsWith("/") ? raw : `${raw}/`;
  const client = new SSMClient({});
  let NextToken;
  do {
    const out = await client.send(
      new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken })
    );
    for (const p of out.Parameters ?? []) {
      const name = p.Name?.slice(path.length) ?? "";
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || p.Value === undefined || p.Value === "unset") continue;
      env[name] ??= p.Value;
    }
    NextToken = out.NextToken;
  } while (NextToken);
}

await loadSsmEnv(process.env);

export const { handler } = await import("../../packages/mcp/dist/lambda.js");
