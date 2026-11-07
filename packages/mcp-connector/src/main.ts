#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * clearance-mcp: the read-only Clearance connector for people, over stdio. Point Claude Code, Claude Desktop or Cursor at it
 * (docs/mcp-connector.md). Only MCP goes to stdout. A setting it can't use is one line on stderr and exit 1, and never
 * prints a token.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoreClient } from "./client.ts";
import { ConfigError, loadConfig, type ConnectorConfig } from "./config.ts";
import { buildConnectorServer } from "./tools.ts";

let config: ConnectorConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(`clearance-mcp: ${error instanceof ConfigError ? error.message : "can't read its settings"}. See docs/mcp-connector.md.`);
  process.exit(1);
}

const server = buildConnectorServer(createCoreClient(config), config);
await server.connect(new StdioServerTransport());
