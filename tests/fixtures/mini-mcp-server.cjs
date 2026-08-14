#!/usr/bin/env node
/**
 * Minimal MCP server over stdio (JSON-RPC, newline-delimited).
 * Usage: node mini-mcp-server.cjs <tool-name>
 *
 * Exposes a single tool whose name is taken from argv[2] (default: "test_tool").
 * The --user-data-dir flag appended by McpClient for perSession servers is
 * silently ignored.
 */
"use strict";

const toolName = (process.argv[2] || "test_tool").replace(/^--.*/, "test_tool");

process.stdin.setEncoding("utf8");

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      // ignore malformed input
    }
  }
});

function handleMessage(msg) {
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: toolName, version: "1.0.0" },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    return;
  }
  if (msg.method === "tools/list") {
    respond(msg.id, {
      tools: [
        {
          name: toolName,
          description: `Tool provided by ${toolName}`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (msg.method === "tools/call") {
    respond(msg.id, {
      content: [{ type: "text", text: `Result from ${toolName}` }],
    });
    return;
  }
  if (msg.id !== undefined) {
    respond(msg.id, {});
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
