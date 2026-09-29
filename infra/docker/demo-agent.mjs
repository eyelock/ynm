// An agent with no git: talks MCP over HTTP to the hosted store.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.YNM_URL ?? "http://localhost:3000/mcp";
const token = process.env.YNM_MCP_TOKEN;
const client = new Client({ name: "demo-agent", version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined)
);
const remember = await client.callTool({
  name: "memory_remember",
  arguments: { type: "procedural", level: "distributed", content: "Deploy checklist: run the release gate before tagging.", tags: ["release"] },
});
console.log("remembered", remember.structuredContent.data.memoryId);
const recall = await client.callTool({ name: "memory_recall", arguments: { text: "release gate tagging" } });
console.log("recall", recall.structuredContent.data.map((h) => h.content));
await client.close();
