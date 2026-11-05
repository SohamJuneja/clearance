/**
 * Starts Acme Mini. Binds to 127.0.0.1 unless ACME_HOST says otherwise. The container sets
 * ACME_HOST=0.0.0.0 because a loopback bind inside a container is unreachable, and its compose file
 * publishes the port on the host's 127.0.0.1 only.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAcmeServer } from "./server";

const PLACEHOLDER_KEY = "change-me";
const DEFAULT_PORT = 7800;

// Values already in the environment win, so the container's settings are never overridden.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const adminKey = process.env.ACME_ADMIN_KEY ?? "";
if (!adminKey || adminKey === PLACEHOLDER_KEY) {
  console.error("ACME_ADMIN_KEY is missing or still the placeholder. Generate one with: openssl rand -hex 24");
  process.exit(1);
}

const host = process.env.ACME_HOST ?? "127.0.0.1";
const port = Number(process.env.ACME_PORT ?? DEFAULT_PORT);
const dbPath = process.env.ACME_DB_PATH ?? resolve(process.cwd(), "data/acme.sqlite");

const app = buildAcmeServer({ dbPath, adminKey, logger: true });

const shutdown = () => {
  void app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port });
