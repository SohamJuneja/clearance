/**
 * A fake Acme and clearance-core behind one HTTP server, for testing the demo runner. Test data only:
 * nothing here is ever a result, and none of it reaches a real run.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export class FakeWorldServer {
  state: {
    refunds: { id: string; amount: number; order_id?: string }[];
    deploys: unknown[];
    outbox: unknown[];
    deleted_records: unknown[];
  } = {
    refunds: [],
    deploys: [],
    outbox: [],
    deleted_records: [],
  };
  ledger: { type: string; request_id?: string }[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/state") return send(200, this.state);
      if (req.url === "/v1/ledger") return send(200, this.ledger);
      if (req.url === "/v1/health") return send(200, { ok: true });
      return send(200, {});
    });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server?.close(() => done());
      this.server?.closeAllConnections();
    });
  }
}
