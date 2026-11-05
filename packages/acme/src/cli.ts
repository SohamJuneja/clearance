/**
 * `acme`: the CLI agents use. It only ever talks to the gate, using the agent's token from
 * ACME_GATE_TOKEN, and prints the gate's response verbatim so the agent sees `HELD CLR-0042 ...`.
 *
 * Exit codes: 0 done, 2 held (202 from the gate), 1 anything else.
 */
import { parseArgs } from "node:util";

export type CliIo = {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const USAGE = `usage: acme <command>
  refund --order <id> --amount <rupees> [--customer <id>] [--dest <upi>]
  deploy <service> <version> --env <env>
  rollback <service> --env <env>
  email --to <addr> --subject <s> --body <b> [--attach <name>]...
  delete <table> <id>
  merge --repo <owner/name> --pr <n>
  order <id> | customer <id> | customers --query <q> | destination <id> | ticket <id>
  services | service <name> | ci <version> | pull <n> | status <request-id>
`;

class UsageError extends Error {}

type GateCall = { method: "GET" | "POST" | "DELETE"; path: string; body?: unknown };

const enc = encodeURIComponent;

function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`missing ${name}`);
  return value;
}

function parseCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      order: { type: "string" },
      amount: { type: "string" },
      customer: { type: "string" },
      dest: { type: "string" },
      env: { type: "string" },
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      attach: { type: "string", multiple: true },
      repo: { type: "string" },
      pr: { type: "string" },
      query: { type: "string" },
    },
  });
  return { values, command: positionals[0], args: positionals.slice(1) };
}

function wholeNumber(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a whole number, got "${raw}"`);
  return Number(raw);
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  const { values, command, args } = parsed;

  const token = io.env.ACME_GATE_TOKEN;
  if (!token) {
    io.stderr("ACME_GATE_TOKEN is not set: the acme CLI only talks to the gate, with the agent's token\n");
    return 1;
  }
  const baseUrl = io.env.ACME_GATE_URL ?? "http://127.0.0.1:7710";

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (io.env.CLEARANCE_ROOM) headers["x-clearance-room"] = io.env.CLEARANCE_ROOM;
  if (io.env.CLEARANCE_THREAD) headers["x-clearance-thread"] = io.env.CLEARANCE_THREAD;

  const send = async (call: GateCall) => {
    const hasBody = call.body !== undefined;
    return fetch(`${baseUrl}${call.path}`, {
      method: call.method,
      headers: hasBody ? { ...headers, "content-type": "application/json" } : headers,
      ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
    });
  };

  /** Fills what the PLAN's short form leaves out. Failing to read it stops the command. */
  const readField = async (path: string, field: string): Promise<string> => {
    const res = await send({ method: "GET", path });
    if (!res.ok) throw new UsageError(`cannot read ${path} from the gate (HTTP ${res.status}); pass the value explicitly`);
    const value = ((await res.json()) as Record<string, unknown>)[field];
    if (typeof value !== "string") throw new UsageError(`${path} has no ${field}; pass the value explicitly`);
    return value;
  };

  try {
    const call = await buildCall(command, args, values, readField);
    const res = await send(call);
    io.stdout(`${await res.text()}\n`);
    if (res.status === 202) return 2;
    return res.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${USAGE}`);
      return 1;
    }
    io.stderr(`cannot reach the gate at ${baseUrl}: ${(error as Error).message}\n`);
    return 1;
  }
}

async function buildCall(
  command: string | undefined,
  args: string[],
  values: ReturnType<typeof parseCommand>["values"],
  readField: (path: string, field: string) => Promise<string>,
): Promise<GateCall> {
  switch (command) {
    case "refund": {
      const order = required(values.order, "--order");
      const amount = wholeNumber(required(values.amount, "--amount"), "--amount");
      const customer = values.customer ?? (await readField(`/acme/orders/${enc(order)}`, "customer_id"));
      const destination = values.dest ?? (await readField(`/acme/customers/${enc(customer)}`, "default_destination"));
      return { method: "POST", path: "/acme/refunds", body: { order_id: order, customer_id: customer, amount, destination } };
    }
    case "deploy":
      return {
        method: "POST",
        path: "/acme/deploys",
        body: { service: required(args[0], "service"), version: required(args[1], "version"), env: required(values.env, "--env") },
      };
    case "rollback":
      return { method: "POST", path: "/acme/rollbacks", body: { service: required(args[0], "service"), env: required(values.env, "--env") } };
    case "email":
      return {
        method: "POST",
        path: "/acme/emails",
        body: {
          to: required(values.to, "--to"),
          subject: values.subject ?? "",
          body: values.body ?? "",
          attachments: values.attach ?? [],
        },
      };
    case "delete":
      return { method: "DELETE", path: `/acme/records/${enc(required(args[0], "table"))}/${enc(required(args[1], "id"))}` };
    case "merge":
      return {
        method: "POST",
        path: "/github/merge",
        body: { repo: required(values.repo, "--repo"), pr: wholeNumber(required(values.pr, "--pr"), "--pr") },
      };
    case "order":
      return { method: "GET", path: `/acme/orders/${enc(required(args[0], "order id"))}` };
    case "customer":
      return { method: "GET", path: `/acme/customers/${enc(required(args[0], "customer id"))}` };
    case "customers":
      return { method: "GET", path: `/acme/customers?query=${enc(values.query ?? "")}` };
    case "destination":
      return { method: "GET", path: `/acme/destinations/${enc(required(args[0], "destination id"))}` };
    case "ticket":
      return { method: "GET", path: `/acme/tickets/${enc(required(args[0], "ticket id"))}` };
    case "services":
      return { method: "GET", path: "/acme/services" };
    case "service":
      return { method: "GET", path: `/acme/services/${enc(required(args[0], "service name"))}` };
    case "ci":
      return { method: "GET", path: `/acme/ci/${enc(required(args[0], "version"))}` };
    case "pull":
      return { method: "GET", path: `/acme/pulls/${enc(required(args[0], "pull number"))}` };
    case "status":
      return { method: "GET", path: `/pending/${enc(required(args[0], "request id"))}` };
    default:
      throw new UsageError(command ? `unknown command "${command}"` : "no command given");
  }
}

if (process.argv[1]?.endsWith("/cli.ts")) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
