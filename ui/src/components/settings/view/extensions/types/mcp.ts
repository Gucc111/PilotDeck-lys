export type Scope = "global" | "project";

export type McpConfigFile = {
  exists: boolean;
  path: string;
  raw: string;
  config: { mcpServers?: Record<string, unknown> };
};

export type McpConfigResponse = {
  global: McpConfigFile;
  project: McpConfigFile;
};

export type KeyValueRow = {
  id: string;
  key: string;
  value: string;
};

export type McpServerForm = {
  id: string;
  name: string;
  connection: "separate" | "shared";
  usage: "concurrent" | "serial";
  maxConnections: string;
  /** Preserve fields owned by plugins and advanced configuration. */
  raw?: Record<string, unknown>;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: KeyValueRow[];
  envPassThrough: string[];
  perSession: boolean;
  url: string;
  headers: KeyValueRow[];
};
