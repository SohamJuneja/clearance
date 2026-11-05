/**
 * Acme Mini: the fake startup Clearance protects. All data is synthetic (see seed.ts).
 *
 * Acme deliberately has no guardrails of its own. It pays ₹40,000 on a ₹4,000 order and deploys a
 * build with failing checks, because holding those is the gate's job and the baseline scenarios
 * (SC1, SC2) depend on them going through. The HTTP surface is the table in
 * docs/integration-contract.md. Additive routes beyond that table are marked below.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { openDb, resetDb, type AcmeDb } from "./db";
import { CURRENCY } from "./seed";

export type AcmeOptions = {
  dbPath: string;
  adminKey: string;
  now?: () => number;
  logger?: boolean;
};

const HOUR = 3_600_000;

const RefundBody = z.object({
  order_id: z.string().min(1),
  customer_id: z.string().min(1),
  amount: z.number().int().positive(),
  destination: z.string().min(1),
});
const DestinationBody = z.object({ customer_id: z.string().min(1), upi: z.string().min(1) });
const DeployBody = z.object({ service: z.string().min(1), env: z.string().min(1), version: z.string().min(1) });
const RollbackBody = z.object({ service: z.string().min(1), env: z.string().min(1) });
const EmailBody = z.object({
  to: z.string().email(),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.string().min(1)).default([]),
});
const MergeBody = z.object({ repo: z.string().min(1).optional() }).default({});
const DELETABLE_TABLES = new Set(["customers", "orders"]);

type Row = Record<string, unknown>;

function sameKey(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function parseOrReply<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  void reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
  return null;
}

const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: "not_found", what });

function destinationView(row: Row, nowMs: number) {
  const addedAt = String(row.added_at);
  const ageHours = Math.max(0, (nowMs - Date.parse(addedAt)) / HOUR);
  return {
    id: row.id,
    customer_id: row.customer_id,
    upi: row.id,
    added_at: addedAt,
    age_hours: Math.round(ageHours * 10_000) / 10_000,
  };
}

function pullView(db: AcmeDb, row: Row) {
  const merged = db.prepare("SELECT 1 FROM merges WHERE number = ?").get(row.number);
  return {
    number: row.number,
    repo: row.repo,
    title: row.title,
    author: row.author,
    changes: row.changes,
    files: JSON.parse(String(row.files)) as string[],
    checks: JSON.parse(String(row.checks)) as unknown,
    diff: row.diff,
    merged: Boolean(merged),
  };
}

function stateView(db: AcmeDb) {
  const seededAt = db.prepare("SELECT value FROM meta WHERE key = 'seeded_at'").get() as { value: string };
  const refunds = db
    .prepare("SELECT id, order_id, customer_id, amount, destination, status, created_at FROM refunds ORDER BY seq")
    .all() as { amount: number }[];
  const liveRows = db.prepare("SELECT service, live_version FROM service_envs WHERE env = 'prod'").all() as {
    service: string;
    live_version: string;
  }[];
  return {
    synthetic: true,
    seeded_at: seededAt.value,
    currency: CURRENCY,
    money_out: refunds.reduce((sum, refund) => sum + refund.amount, 0),
    refunds,
    deploys: db.prepare("SELECT id, service, env, version, previous_version, status, created_at FROM deploys ORDER BY seq").all(),
    rollbacks: db.prepare("SELECT id, service, env, from_version, to_version, created_at FROM rollbacks ORDER BY seq").all(),
    live_versions: Object.fromEntries(liveRows.map((row) => [row.service, row.live_version])),
    outbox: (db.prepare("SELECT id, recipient, subject, body, attachments, status, created_at FROM outbox ORDER BY seq").all() as Row[]).map(
      ({ recipient, attachments, ...rest }) => ({ ...rest, to: recipient, attachments: JSON.parse(String(attachments)) as unknown }),
    ),
    deleted_records: (db.prepare("SELECT tbl, record_id, row, deleted_at FROM deleted_records ORDER BY seq").all() as Row[]).map((row) => ({
      table: row.tbl,
      id: row.record_id,
      row: JSON.parse(String(row.row)) as unknown,
      deleted_at: row.deleted_at,
    })),
    merges: db.prepare("SELECT number, repo, sha, merged_at FROM merges ORDER BY seq").all(),
    destinations_added: db.prepare("SELECT id, customer_id, added_at FROM destinations WHERE seeded = 0").all(),
  };
}

export function buildAcmeServer(options: AcmeOptions): FastifyInstance {
  if (!options.adminKey) throw new Error("ACME_ADMIN_KEY must be set: Acme refuses to run without a custody credential");
  const now = options.now ?? Date.now;
  const db = openDb(options.dbPath, now());
  const nowIso = () => new Date(now()).toISOString();
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onClose", async () => {
    db.close();
  });

  // Proxies send a JSON content type on bodyless DELETEs and resets; treat empty as no body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
    }
  });

  // Every route needs the admin key except the exact GET /health route.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "GET" && req.routeOptions.url === "/health") return;
    if (!sameKey(req.headers["x-acme-admin-key"], options.adminKey)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "acme", synthetic: true }));

  // ── Payments ────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const row = db.prepare("SELECT id, customer_id, total, status, items FROM orders WHERE id = ?").get(req.params.id) as Row | undefined;
    if (!row) return notFound(reply, "order");
    return { ...row, items: JSON.parse(String(row.items)) as unknown };
  });

  const customerView = (row: Row) => ({
    ...row,
    orders: (db.prepare("SELECT id FROM orders WHERE customer_id = ?").all(row.id) as { id: string }[]).map((o) => o.id),
    destinations: (db.prepare("SELECT id FROM destinations WHERE customer_id = ?").all(row.id) as { id: string }[]).map((d) => d.id),
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id) as Row | undefined;
    if (!row) return notFound(reply, "customer");
    return customerView(row);
  });

  app.get<{ Querystring: { query?: string } }>("/customers", async (req) => {
    const query = (req.query.query ?? "").toLowerCase();
    const rows = db
      .prepare("SELECT * FROM customers WHERE ? = '' OR instr(lower(id || ' ' || name || ' ' || email), ?) > 0 ORDER BY id")
      .all(query, query) as Row[];
    return rows.map(customerView);
  });

  app.post("/refunds", async (req, reply) => {
    const body = parseOrReply(RefundBody, req.body, reply);
    if (!body) return reply;
    if (!db.prepare("SELECT 1 FROM orders WHERE id = ?").get(body.order_id)) return notFound(reply, "order");
    if (!db.prepare("SELECT 1 FROM customers WHERE id = ?").get(body.customer_id)) return notFound(reply, "customer");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM refunds").get() as { n: number }).n;
    const refund = { id: `re_${7731 + count}`, ...body, status: "processed", created_at: nowIso() };
    db.prepare("INSERT INTO refunds (id, order_id, customer_id, amount, destination, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
      refund.id, refund.order_id, refund.customer_id, refund.amount, refund.destination, refund.status, refund.created_at,
    );
    return reply.code(201).send(refund);
  });

  app.get<{ Params: { id: string } }>("/destinations/:id", async (req, reply) => {
    const row = db.prepare("SELECT * FROM destinations WHERE id = ?").get(req.params.id) as Row | undefined;
    if (!row) return notFound(reply, "destination");
    return destinationView(row, now());
  });

  app.post("/payouts/destinations", async (req, reply) => {
    const body = parseOrReply(DestinationBody, req.body, reply);
    if (!body) return reply;
    if (!db.prepare("SELECT 1 FROM customers WHERE id = ?").get(body.customer_id)) return notFound(reply, "customer");
    if (db.prepare("SELECT 1 FROM destinations WHERE id = ?").get(body.upi)) {
      return reply.code(409).send({ error: "already_exists", what: "destination" });
    }
    const addedAt = nowIso();
    db.prepare("INSERT INTO destinations VALUES (?,?,?,0)").run(body.upi, body.customer_id, addedAt);
    return reply.code(201).send(destinationView({ id: body.upi, customer_id: body.customer_id, added_at: addedAt }, now()));
  });

  // ── Deploy ──────────────────────────────────────────────────────────────────
  const serviceView = (row: Row) => {
    const prod = db.prepare("SELECT live_version FROM service_envs WHERE service = ? AND env = 'prod'").get(row.name) as { live_version: string } | undefined;
    return { name: row.name, live_version: prod?.live_version ?? null, owner: row.owner };
  };

  app.get("/services", async () => (db.prepare("SELECT * FROM services ORDER BY name").all() as Row[]).map(serviceView));

  app.get<{ Params: { name: string } }>("/services/:name", async (req, reply) => {
    const row = db.prepare("SELECT * FROM services WHERE name = ?").get(req.params.name) as Row | undefined;
    if (!row) return notFound(reply, "service");
    return serviceView(row);
  });

  app.get<{ Params: { version: string } }>("/ci/:version", async (req, reply) => {
    const row = db.prepare("SELECT version, failing FROM ci WHERE version = ?").get(req.params.version) as { version: string; failing: string } | undefined;
    if (!row) return notFound(reply, "ci");
    const failing = JSON.parse(row.failing) as string[];
    return { version: row.version, status: failing.length === 0 ? "passing" : "failing", failing };
  });

  app.post("/deploys", async (req, reply) => {
    const body = parseOrReply(DeployBody, req.body, reply);
    if (!body) return reply;
    if (!db.prepare("SELECT 1 FROM services WHERE name = ?").get(body.service)) return notFound(reply, "service");
    const current = db.prepare("SELECT live_version FROM service_envs WHERE service = ? AND env = ?").get(body.service, body.env) as { live_version: string } | undefined;
    const previous = current?.live_version ?? null;
    const count = (db.prepare("SELECT COUNT(*) AS n FROM deploys").get() as { n: number }).n;
    const deploy = { id: `dep_${5100 + count}`, ...body, previous_version: previous, status: "deployed", created_at: nowIso() };
    db.transaction(() => {
      db.prepare(
        `INSERT INTO service_envs (service, env, live_version, previous_version) VALUES (?,?,?,?)
         ON CONFLICT(service, env) DO UPDATE SET live_version = excluded.live_version, previous_version = excluded.previous_version`,
      ).run(body.service, body.env, body.version, previous);
      db.prepare("INSERT INTO deploys (id, service, env, version, previous_version, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
        deploy.id, deploy.service, deploy.env, deploy.version, deploy.previous_version, deploy.status, deploy.created_at,
      );
    })();
    return reply.code(201).send(deploy);
  });

  app.post("/rollbacks", async (req, reply) => {
    const body = parseOrReply(RollbackBody, req.body, reply);
    if (!body) return reply;
    if (!db.prepare("SELECT 1 FROM services WHERE name = ?").get(body.service)) return notFound(reply, "service");
    const current = db.prepare("SELECT live_version, previous_version FROM service_envs WHERE service = ? AND env = ?").get(body.service, body.env) as
      | { live_version: string; previous_version: string | null }
      | undefined;
    if (!current?.previous_version) return reply.code(409).send({ error: "nothing_to_roll_back", service: body.service, env: body.env });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM rollbacks").get() as { n: number }).n;
    const rollback = {
      id: `rb_${3300 + count}`,
      ...body,
      from_version: current.live_version,
      to_version: current.previous_version,
      created_at: nowIso(),
    };
    db.transaction(() => {
      db.prepare("UPDATE service_envs SET live_version = ?, previous_version = NULL WHERE service = ? AND env = ?").run(rollback.to_version, body.service, body.env);
      db.prepare("INSERT INTO rollbacks (id, service, env, from_version, to_version, created_at) VALUES (?,?,?,?,?,?)").run(
        rollback.id, rollback.service, rollback.env, rollback.from_version, rollback.to_version, rollback.created_at,
      );
    })();
    return reply.code(201).send(rollback);
  });

  // ── Email: outbox only, nothing leaves the machine ─────────────────────────
  app.post("/emails", async (req, reply) => {
    const body = parseOrReply(EmailBody, req.body, reply);
    if (!body) return reply;
    const attachments: { name: string; rows: number; bytes: number }[] = [];
    for (const name of body.attachments) {
      const file = db.prepare("SELECT name, rows, length(content) AS bytes FROM files WHERE name = ?").get(name) as
        | { name: string; rows: number; bytes: number }
        | undefined;
      if (!file) return reply.code(400).send({ error: "unknown_attachment", name });
      attachments.push(file);
    }
    const count = (db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
    const email = { id: `em_${2200 + count}`, to: body.to, subject: body.subject, body: body.body, attachments, status: "outbox", created_at: nowIso() };
    db.prepare("INSERT INTO outbox (id, recipient, subject, body, attachments, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
      email.id, email.to, email.subject, email.body, JSON.stringify(attachments), email.status, email.created_at,
    );
    return reply.code(201).send(email);
  });

  // Additive to the contract: PLAN 8.1 seeds template replies, this makes them reachable.
  app.get("/emails/templates", async () => db.prepare("SELECT id, subject, body FROM email_templates ORDER BY id").all());

  // Additive to the contract: `{name, rows, bytes}` lets a caller implement the policy's count_rows().
  app.get<{ Params: { name: string } }>("/files/:name", async (req, reply) => {
    const row = db.prepare("SELECT name, rows, length(content) AS bytes FROM files WHERE name = ?").get(req.params.name) as Row | undefined;
    if (!row) return notFound(reply, "file");
    return { ...row, synthetic: true };
  });

  app.get<{ Params: { name: string } }>("/files/:name/content", async (req, reply) => {
    const row = db.prepare("SELECT content FROM files WHERE name = ?").get(req.params.name) as { content: string } | undefined;
    if (!row) return notFound(reply, "file");
    return reply.type("text/csv; charset=utf-8").send(row.content);
  });

  // ── Records ─────────────────────────────────────────────────────────────────
  app.delete<{ Params: { table: string; id: string } }>("/records/:table/:id", async (req, reply) => {
    const { table, id } = req.params;
    // `table` is only ever interpolated after this allow-list check.
    if (!DELETABLE_TABLES.has(table)) return reply.code(400).send({ error: "invalid_table", allowed: [...DELETABLE_TABLES] });
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return notFound(reply, "record");
    db.transaction(() => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      db.prepare("INSERT INTO deleted_records (tbl, record_id, row, deleted_at) VALUES (?,?,?,?)").run(table, id, JSON.stringify(row), nowIso());
    })();
    return { deleted: true, table, id };
  });

  // ── Tickets ─────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/tickets/:id", async (req, reply) => {
    const row = db.prepare("SELECT id, customer_id, order_id, subject, body FROM tickets WHERE id = ?").get(req.params.id);
    if (!row) return notFound(reply, "ticket");
    return row;
  });

  // ── Fake GitHub ─────────────────────────────────────────────────────────────
  app.get<{ Params: { n: string } }>("/pulls/:n", async (req, reply) => {
    const row = db.prepare("SELECT * FROM pulls WHERE number = ?").get(Number(req.params.n)) as Row | undefined;
    if (!row) return notFound(reply, "pull");
    return pullView(db, row);
  });

  // Additive to the contract: gives the gate's POST /github/merge somewhere to land, so /state can report merges.
  app.post<{ Params: { n: string } }>("/pulls/:n/merge", async (req, reply) => {
    const body = parseOrReply(MergeBody, req.body ?? {}, reply);
    if (!body) return reply;
    const number = Number(req.params.n);
    const row = db.prepare("SELECT number, repo FROM pulls WHERE number = ?").get(number) as { number: number; repo: string } | undefined;
    if (!row || (body.repo !== undefined && body.repo !== row.repo)) return notFound(reply, "pull");
    if (db.prepare("SELECT 1 FROM merges WHERE number = ?").get(number)) return reply.code(409).send({ error: "already_merged", number });
    const merge = { merged: true, number, repo: row.repo, sha: createHash("sha1").update(`merge-${number}`).digest("hex"), merged_at: nowIso() };
    db.prepare("INSERT INTO merges (number, repo, sha, merged_at) VALUES (?,?,?,?)").run(merge.number, merge.repo, merge.sha, merge.merged_at);
    return reply.code(201).send(merge);
  });

  // ── State and reset ─────────────────────────────────────────────────────────
  app.get("/state", async () => stateView(db));

  app.post("/admin/reset", async () => {
    const started = performance.now();
    resetDb(db, now());
    return { ok: true, synthetic: true, ms: Math.round(performance.now() - started) };
  });

  return app;
}
