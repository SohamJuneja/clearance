/**
 * The gate's MCP server: streamable HTTP at /mcp, with the same per-agent token as the HTTP routes.
 * Tools are a thin skin over `GateService.perform`, so there is one path through core's `check`.
 *
 * A hold answers `PENDING CLR-0042` at once and never waits for the decision, because the vendors'
 * MCP clients give up at around 60 s. Stateless: each POST gets its own server and transport, and
 * there are no sessions to keep or lose across a restart.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OPERATIONS, type OperationName } from "./operations.js";
import type { GateReply, GateService, Hints, Principal } from "./service.js";

const ACTION_TOOLS: { name: string; op: OperationName; description: string }[] = [
  {
    name: "refund_customer",
    op: "refund",
    description:
      "Refund a customer for an order. Amount is whole rupees. May answer PENDING with a request id while a person decides; if so, stop and report the id.",
  },
  {
    name: "deploy_service",
    op: "deploy",
    description:
      "Deploy a version of a service to an environment. May answer PENDING with a request id while a person decides; if so, stop and report the id.",
  },
  {
    name: "send_customer_email",
    op: "email",
    description:
      "Send an email to a customer, optionally with named attachments. May answer PENDING with a request id while a person decides; if so, stop and report the id.",
  },
  {
    name: "delete_records",
    op: "delete",
    description:
      "Delete one record from a table. May answer PENDING with a request id while a person decides; if so, stop and report the id.",
  },
  {
    name: "merge_pull_request",
    op: "merge",
    description:
      "Merge a pull request. May answer PENDING with a request id while a person decides; if so, stop and report the id.",
  },
];

const CheckClearanceArgs = z.object({ request_id: z.string().min(1).max(256) }).strict();

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function messageOf(out: GateReply): string {
  const message = (out.body as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : JSON.stringify(out.body);
}

function toToolResult(out: GateReply): CallToolResult {
  if (out.status === 202) {
    const requestId = (out.body as { request_id: string }).request_id;
    return text(`PENDING ${requestId}\n${messageOf(out)}`);
  }
  if (out.status >= 200 && out.status < 300) return text(out.raw?.text ?? JSON.stringify(out.body));
  if (out.status === 403) return text(`DENIED: ${messageOf(out)}`, true);
  if (out.status === 400) return text(`INVALID: ${messageOf(out)}`, true);
  if (out.status === 503) return text(`UNAVAILABLE: ${messageOf(out)}`, true);
  return text(`FAILED (${out.status}): ${out.raw?.text ?? messageOf(out)}`, true);
}

function toPollResult(out: GateReply): CallToolResult {
  if (out.status === 200) return text(`${messageOf(out)}\n${JSON.stringify(out.body)}`);
  if (out.status === 503) return text(`UNAVAILABLE: ${messageOf(out)}`, true);
  return text(messageOf(out), true);
}

function buildMcpServer(service: GateService, principal: Principal, hints: Hints): McpServer {
  const server = new McpServer({ name: "clearance_gate", version: "0.1.0" });
  for (const tool of ACTION_TOOLS) {
    const op = OPERATIONS[tool.op];
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: op.schema },
      async (args: Record<string, unknown>) =>
        toToolResult(await service.perform(principal, op, args, hints)),
    );
  }
  server.registerTool(
    "check_clearance",
    {
      description:
        "Check a request id from a PENDING answer. Waiting for the decision is normal: you will also be told in the thread.",
      inputSchema: CheckClearanceArgs,
    },
    async ({ request_id }) => toPollResult(await service.pending(principal, request_id)),
  );
  return server;
}

export function mountMcp(
  app: FastifyInstance,
  service: GateService,
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  hintsOf: (req: FastifyRequest) => Hints,
): void {
  app.post("/mcp", { onRequest: requireAgent }, async (req, reply) => {
    const server = buildMcpServer(service, req.principal!, hintsOf(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ reason: err instanceof Error ? err.message : "mcp error" }, "mcp failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(503, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "The gate could not complete this call." },
            id: null,
          }),
        );
      }
    }
  });

  // There are no sessions, so no server-initiated stream to open and nothing to delete.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      onRequest: requireAgent,
      handler: async (_req, reply) =>
        reply
          .status(405)
          .header("allow", "POST")
          .send({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }),
    });
  }
}
