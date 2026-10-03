import { type CallToolResult, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { guidance, guidanceNames, type Level } from "@ynm/model";
import {
  openYnm,
  REMEMBER_INTENT_EXAMPLES,
  TOOL_SPECS,
  type ToolSpec,
  wikiPages,
  type Ynm,
} from "@ynm/service";
import { z } from "zod";
import { jsonBytes, recordCall } from "./audit.js";
import { storeFor } from "./identity.js";

export interface YnmServerOptions {
  /** Working directory the service is opened from; hosted servers point this at a bare repo. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  /** Hosted servers mount no personal store. */
  noPersonal?: boolean;
  /**
   * The levels of the mounts actually open, which the instructions describe. Without it they are
   * inferred from `noPersonal`: personal and distributed, or distributed alone.
   */
  levels?: readonly Level[];
}

function levelLine(levels: readonly Level[]): string {
  const personal = levels.includes("personal");
  const distributed = levels.includes("distributed");
  if (personal && distributed)
    return "Levels: personal by default (private to the user); distributed only for team-safe project facts.";
  if (personal) return "Level: personal (private to the user); no distributed store is open.";
  if (distributed)
    return "Level: distributed only: everything stored on this server is shared with everyone who uses it, and it can keep nothing private. memory_remember stores nothing unless level is distributed, so before the user's first memory here, tell them it will be shared and ask; if they want it private, it belongs in a local ynm. Leave namespace out and a shared memory is filed as theirs (user/<their person id> once signed in); name one such as common to file it with the team.";
  return "No store is open yet; a tool call says why.";
}

/**
 * The server `instructions`, which clients that read them (Claude Code puts them in the system
 * prompt) see in every session. For a client connected by URL alone, with no hooks, no skill and
 * no instruction-file block, this and the tool descriptions are all the guidance it gets, so they
 * claim the job outright. Built from the levels the server actually serves.
 */
export function serverInstructions(levels: readonly Level[]): string {
  return [
    "ynm is this user's persistent memory, kept across sessions and agents. Use it instead of any built-in memory, memory directory or notes file.",
    `- Whenever the user asks you to remember something, or states a preference or a standing instruction (${REMEMBER_INTENT_EXAMPLES}), call memory_remember: one memory per fact, never secrets. If a memory on it exists, use memory_supersede instead.`,
    "- Before answering about the user, their preferences, the project or past decisions, read memory_context or call memory_recall with the key terms.",
    `- ${levelLine(levels)}`,
  ].join("\n");
}

/** The levels a server opened with these options serves, when the mounts are not known yet. */
function inferredLevels(opts: YnmServerOptions): readonly Level[] {
  return opts.levels ?? (opts.noPersonal ? ["distributed"] : ["personal", "distributed"]);
}

/**
 * What a tool's result says about the memories it touched, for the audit event: ids only (a write
 * names one, a recall lists its hits), and how many results there were. Never content.
 */
function touched(data: unknown): { memoryIds?: string[]; resultCount?: number } {
  const idOf = (x: unknown) =>
    x && typeof x === "object" && typeof (x as { memoryId?: unknown }).memoryId === "string"
      ? (x as { memoryId: string }).memoryId
      : undefined;
  if (Array.isArray(data)) {
    const ids = data.map(idOf).filter((x): x is string => !!x);
    return { resultCount: data.length, ...(ids.length ? { memoryIds: ids } : {}) };
  }
  const id = idOf(data);
  return id ? { memoryIds: [id] } : {};
}

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
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: serverInstructions(inferredLevels(opts)),
    }
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
      async (args, ctx) => {
        const inputBytes = jsonBytes(args ?? {});
        try {
          const ynm = await storeFor(await getYnm(), ctx?.http?.authInfo);
          const r = await spec.run(ynm, spec.input.parse(args ?? {}));
          recordCall({ tool: spec.name, status: "ok", inputBytes, ...touched(r.data) });
          return toolResult(r.data, r.guidance);
        } catch (err) {
          recordCall({ tool: spec.name, status: "error", inputBytes });
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

  server.registerResource(
    "wiki",
    new ResourceTemplate("memory://{mount}/wiki/{+path}", { list: undefined }),
    {
      description:
        "A page of the markdown projection: index.md, log.md, memories/<id>.md, entities/<slug>.md, topics/<slug>.md",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const ynm = await getYnm();
      const mount = ynm.mount(String(variables.mount));
      const path = String(variables.path);
      const page = (await wikiPages(ynm, mount)).find((p) => p.path === path);
      if (!page) throw new Error(`no wiki page ${path} in mount ${mount.id}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: page.content }] };
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
