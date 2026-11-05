/**
 * Prints participant links: `pnpm study:links https://example.trycloudflare.com [count]`.
 * Sends nothing. The tunnel URL changes every time a quick tunnel restarts, but the part after
 * /p/ stays valid for as long as STUDY_LINK_SECRET does.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignGroup } from "../lib/protocol";
import { linkToken } from "./server";

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const secret = process.env.STUDY_LINK_SECRET ?? "";
if (!secret || secret === "change-me") {
  console.error("STUDY_LINK_SECRET is missing or still the placeholder. Generate one with: openssl rand -hex 24");
  process.exit(1);
}

const base = (process.argv[2] ?? `http://127.0.0.1:${process.env.STUDY_PORT ?? 7950}`).replace(/\/+$/, "");
const count = Number(process.argv[3] ?? 20);

for (let n = 1; n <= count; n += 1) {
  const participant = `p${String(n).padStart(2, "0")}`;
  const { blocks } = assignGroup(participant);
  const order = blocks.map((b) => `${b.condition}-${b.set}`).join(" then ");
  console.log(`${participant}  ${order}  ${base}/p/${linkToken(participant, secret)}`);
}
