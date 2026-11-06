/**
 * Starts the Desk on port 7900. `pnpm desk:start` builds the page first.
 * DESK_FIXTURE=1 serves synthetic data for screenshots, behind a banner the page cannot hide.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { httpCore } from "./core-source";
import { fixtureCore } from "./fixture";
import { createDeskServer } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

const envFile = resolve(repo, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PLACEHOLDER = "change-me";
const synthetic = process.env.DESK_FIXTURE === "1";
const token = process.env.CLEARANCE_INTERNAL_TOKEN ?? "";
const distDir = resolve(here, "../../dist");
const port = Number(process.env.CLEARANCE_DESK_PORT ?? 7900);
const coreUrl = (process.env.CLEARANCE_CORE_URL ?? `http://127.0.0.1:${process.env.CLEARANCE_CORE_PORT ?? 7700}`).replace(/\/+$/, "");
const policyPath = resolve(repo, process.env.CLEARANCE_POLICY_PATH ?? "policy/clearance.policy.yaml");
const teamPath = resolve(repo, process.env.CLEARANCE_TEAM_PATH ?? "policy/team.yaml");

if (!existsSync(resolve(distDir, "index.html"))) {
  console.error("desk: no build found. Run: pnpm desk:build (pnpm desk:start does it for you)");
  process.exit(1);
}
if (!synthetic && (!token || token === PLACEHOLDER)) {
  console.error("desk: CLEARANCE_INTERNAL_TOKEN is missing or still the placeholder. Generate one with: openssl rand -hex 24");
  console.error("desk: to look around without core, on labelled synthetic data: pnpm desk:fixture");
  process.exit(1);
}

const server = createDeskServer({
  core: synthetic ? fixtureCore({ policyPath }) : httpCore({ url: coreUrl, token }),
  synthetic,
  distDir,
  policyPath,
  teamPath,
  allowedHosts: (process.env.DESK_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  console.log(`desk: http://127.0.0.1:${port}`);
  console.log(synthetic ? "desk: FIXTURE MODE: all data is synthetic, and the page says so" : `desk: reading core at ${coreUrl}`);
});
