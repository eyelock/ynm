import {
  type AuthProvider,
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ContextBlock } from "@ynm/index";

/**
 * A remote mount (ADR-004): a hosted ynm reached over MCP, signed in as the person (ADR-017).
 * It holds no records locally; reads and writes are the hosted store's own tools, so attribution,
 * scopes and audit all happen there. Always the distributed level.
 */
export interface RemoteStoreOptions {
  id: string;
  url: string;
  /** Signs requests: the stored OAuth credentials, or a fixed token in tests. */
  authProvider?: OAuthClientProvider | AuthProvider;
  fetch?: typeof fetch;
  /** Default time a call may take before the remote is treated as unavailable. */
  timeoutMs?: number;
  version?: string;
  /** The connection to use instead of Streamable HTTP to `url` (tests). */
  transport?: () => Transport | Promise<Transport>;
}

/** The remote could not be reached, refused the credentials, or took too long. */
export class RemoteUnavailableError extends Error {
  constructor(
    readonly mount: string,
    message: string
  ) {
    super(`${mount}: ${message}`);
    this.name = "RemoteUnavailableError";
  }
}

/** A tool call the remote answered with an error, such as an unknown memory id. */
export class RemoteToolError extends Error {
  constructor(
    readonly mount: string,
    message: string
  ) {
    super(message);
    this.name = "RemoteToolError";
  }
}

export class RemoteStore {
  readonly id: string;
  readonly url: string;
  readonly level = "distributed" as const;
  readonly provider = "mcp" as const;
  private readonly opts: RemoteStoreOptions;
  private client?: Promise<Client>;

  constructor(opts: RemoteStoreOptions) {
    this.id = opts.id;
    this.url = opts.url;
    this.opts = opts;
  }

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "ynm", version: this.opts.version ?? "0.0.0" });
      const transport = this.opts.transport
        ? await this.opts.transport()
        : new StreamableHTTPClientTransport(new URL(this.url), {
            authProvider: this.opts.authProvider,
            ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
          });
      await client.connect(transport);
      return client;
    })().catch((err: unknown) => {
      this.client = undefined; // try again on the next call
      throw err;
    });
    return this.client;
  }

  /** One tool call, bounded by a timeout; returns the tool's `data`. */
  async call<T>(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const limit = timeoutMs ?? this.opts.timeoutMs ?? 15_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RemoteUnavailableError(this.id, `no answer within ${limit} ms`)),
        limit
      );
    });
    try {
      const result = (await Promise.race([
        this.connect().then((c) => c.callTool({ name: tool, arguments: args })),
        timeout,
      ])) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown };
      if (result.isError)
        throw new RemoteToolError(
          this.id,
          result.content?.map((c) => c.text ?? "").join(" ") ?? ""
        );
      return (result.structuredContent as { data: T } | undefined)?.data as T;
    } catch (err) {
      if (err instanceof RemoteToolError || err instanceof RemoteUnavailableError) throw err;
      throw new RemoteUnavailableError(this.id, describe(err, this.id));
    } finally {
      clearTimeout(timer);
    }
  }

  async context(query: Record<string, unknown>, timeoutMs?: number): Promise<ContextBlock> {
    return this.call<ContextBlock>("memory_context", query, timeoutMs);
  }

  async close(): Promise<void> {
    const c = await this.client?.catch(() => undefined);
    this.client = undefined;
    await c?.close();
  }
}

function describe(err: unknown, id: string): string {
  const message = err instanceof Error ? err.message : String(err);
  // Every sign-in failure reads the same, whichever layer noticed it.
  if (/unauthori[sz]ed|401|invalid_token|not signed in|ynm login/i.test(message))
    return `not signed in: run \`ynm login ${id}\``;
  return message;
}
