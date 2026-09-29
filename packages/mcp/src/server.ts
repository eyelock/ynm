import { type CallToolResult, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { guidance, guidanceNames } from "@ynm/model";
import { openYnm, TOOL_SPECS, type ToolSpec, type Ynm } from "@ynm/service";
import { z } from "zod";

export interface YnmServerOptions {
  /** Working directory the service is opened from; hosted servers point this at a bare repo. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  /** Hosted servers mount no personal store. */
  noPersonal?: boolean;
}

const INSTRUCTIONS = `ynm gives you persistent memory. Read memory_context (or call memory_recall with the task's key terms) before answering questions about the project, the user or past decisions. Record durable facts with memory_remember: one memory per fact, personal by default, distributed only for team-safe project facts, never secrets. Prefer memory_supersede over duplicates.`;

/** The service is opened once per process; index freshness covers writes from elsewhere. */
export function serviceCache(opts: YnmServerOptions): () => Promise<Ynm> {
  let pending: Promise<Ynm> | null = null;
  return () => {
    pending ??= openYnm({ cwd: opts.cwd, env: opts.env, noPersonal: opts.noPersonal }).then(
      (c) => c.ynm
    );
    return pending;
  };
}

function toolResult(data: unknown, guidanceText?: string): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text: guidanceText ? `${text}\n\nGuidance: ${guidanceText}` : text }],
    structuredContent: { data, guidance: guidanceText ?? null },
  };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Builds a stateless server: tools from the shared specs, resources and prompts (ADR-008). */
export function createYnmServer(
  opts: YnmServerOptions,
  getYnm: () => Promise<Ynm> = serviceCache(opts)
): McpServer {
  const server = new McpServer(
    { name: "ynm", version: opts.version ?? "0.1.0", title: "ynm: your named memory" },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS }
  );

  for (const spec of TOOL_SPECS as readonly ToolSpec[]) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.input,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.name === "memory_forget",
          idempotentHint: spec.readOnly,
        },
      },
      async (args) => {
        try {
          const ynm = await getYnm();
          const r = await spec.run(ynm, spec.input.parse(args ?? {}));
          return toolResult(r.data, r.guidance);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  server.registerResource(
    "status",
    "memory://status",
    { description: "Mounts, shard counts and index freshness", mimeType: "application/json" },
    async (uri) => {
      const ynm = await getYnm();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { ...(await ynm.status()), index: await ynm.indexStatus() },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerResource(
    "context",
    "memory://context",
    {
      description: "The session-start memory block (pinned first, then ranked)",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const ynm = await getYnm();
      return {
        contents: [
          { uri: uri.href, mimeType: "text/markdown", text: (await ynm.context({})).markdown },
        ],
      };
    }
  );

  server.registerResource(
    "memory",
    new ResourceTemplate("memory://{mount}/{memoryId}", { list: undefined }),
    { description: "One memory by mount and id, as JSON", mimeType: "application/json" },
    async (uri, variables) => {
      const ynm = await getYnm();
      const memoryId = String(variables.memoryId);
      const m = await ynm.find(memoryId);
      if (!m || m.mount !== String(variables.mount))
        throw new Error(`no memory ${memoryId} in mount ${String(variables.mount)}`);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(m, null, 2) },
        ],
      };
    }
  );

  for (const name of guidanceNames()) {
    server.registerPrompt(
      `memory-${name}`,
      { description: `ynm guidance: ${name.replace(/-/g, " ")}`, argsSchema: z.object({}) },
      async () => ({
        messages: [{ role: "user", content: { type: "text", text: guidance(name) } }],
      })
    );
  }

  return server;
}
