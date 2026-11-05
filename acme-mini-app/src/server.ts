/** A tiny HTTP front for the fake checkout: POST /quote with a cart, GET /health. */
import { createServer } from "node:http";
import { quote, type Cart } from "./checkout.ts";

const PORT = Number(process.env.CHECKOUT_PORT ?? 7810);

const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/quote") return send(404, { error: "not found" });

  let text = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (text += chunk));
  req.on("end", () => {
    try {
      send(200, quote(JSON.parse(text) as Cart));
    } catch (err) {
      send(400, { error: (err as Error).message });
    }
  });
});

server.listen(PORT, "127.0.0.1");
