/** Starts clearance-gate. Run with `tsx --env-file=.env packages/gate/src/main.ts`. */
import { loadGateConfig } from "./config.js";
import { buildGateServer } from "./server.js";

const config = loadGateConfig(process.env);
const app = buildGateServer(config, { logger: { level: process.env.LOG_LEVEL ?? "info" } });

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await app.listen({ port: config.port, host: config.host });
