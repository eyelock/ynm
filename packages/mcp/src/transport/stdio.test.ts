import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type Transport } from "@modelcontextprotocol/server";
import type { ServeStdioOptions } from "@modelcontextprotocol/server/stdio";
import { startStdio } from "./stdio.js";

/**
 * startStdio binds the process's own stdin/stdout, which a test cannot share with the vitest
 * worker. The real serveStdio is kept; the mock only records the options startStdio passes and
 * swaps in one end of a linked in-memory pair, so the whole stdio path runs in process.
 */
const seam = vi.hoisted(() => ({
  transport: undefined as Transport | undefined,
  options: [] as ServeStdioOptions[],
}));

vi.mock("@modelcontextprotocol/server/stdio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@modelcontextprotocol/server/stdio")>();
  return {
    ...real,
    serveStdio: (factory: Parameters<typeof real.serveStdio>[0], options: ServeStdioOptions) => {
      seam.options.push(options);
      return real.serveStdio(factory, { ...options, transport: seam.transport });
    },
  };
});

function factory(): McpServer {
  const server = new McpServer(
    { name: "stdio-test", version: "0" },
    { capabilities: { tools: {} } }
  );
  server.registerTool("ping", { description: "answers pong" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

describe("stdio transport", () => {
  type Handler = (...args: unknown[]) => unknown;
  let signals: Map<string, Handler>;

  beforeEach(() => {
    seam.options.length = 0;
    signals = new Map();
    // Capture the signal handlers instead of installing them on the worker process.
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: Handler) => {
      signals.set(event, handler);
      return process;
    }) as typeof process.on);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a client end to end and installs SIGINT and SIGTERM shutdown", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    seam.transport = serverT;
    const handle = startStdio(factory);
    expect(seam.options[0]?.legacy).toBe("serve");
    // beforeExit closes telemetry when the client closes stdin, whether or not it is on yet: a
    // server can start it later, on the spool recheck.
    expect([...signals.keys()].sort()).toEqual(["SIGINT", "SIGTERM", "beforeExit"]);

    const client = new Client({ name: "stdio-client", version: "0" });
    await client.connect(clientT);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping"]);
    const r = await client.callTool({ name: "ping", arguments: {} });
    expect((r.content as Array<{ text: string }>)[0]?.text).toBe("pong");
    await client.close();
    await handle.close();
  });

  it("maps rejectLegacy to the SDK's reject mode", async () => {
    seam.transport = InMemoryTransport.createLinkedPair()[1];
    const handle = startStdio(factory, { rejectLegacy: true });
    expect(seam.options[0]?.legacy).toBe("reject");
    await handle.close();
  });

  it("reports out-of-band errors on stderr, never stdout", async () => {
    seam.transport = InMemoryTransport.createLinkedPair()[1];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const handle = startStdio(factory);
    seam.options[0]?.onerror?.(new Error("frame too large"));
    expect(err).toHaveBeenCalledWith("[ynm-mcp] frame too large");
    expect(out).not.toHaveBeenCalled();
    await handle.close();
  });

  it("closes the connection and exits 0 on a termination signal", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    seam.transport = serverT;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    startStdio(factory);
    const client = new Client({ name: "stdio-client", version: "0" });
    await client.connect(clientT);
    let clientClosed = false;
    client.onclose = () => {
      clientClosed = true;
    };
    await signals.get("SIGTERM")?.();
    expect(exit).toHaveBeenCalledWith(0);
    expect(clientClosed).toBe(true);
  });
});
