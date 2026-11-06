/**
 * `pnpm video:desk`: stills of the real Desk at http://127.0.0.1:7900, into docs/media/raw/desk/. Read-only: it opens the
 * tabs, takes a picture and closes the browser. Run it right after a take, so what the Desk shows is that take's ledger.
 *
 * `pnpm desk:e2e` writes fixture-mode pictures to the same folder, with a SYNTHETIC banner. These are named `live-*`
 * so the video can't pick one of those up by accident, and a page showing that banner is refused here.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setting } from "../../eval/lib/paths.ts";
import { launchBrowser, RAW_MEDIA } from "./capture.ts";

export const DESK_TABS = ["ledger", "queue"] as const;
export const deskShot = (tab: string): string => `desk/live-${tab}.png`;

async function main(): Promise<number> {
  const base = setting("CLEARANCE_DESK_URL") ?? "http://127.0.0.1:7900";
  mkdirSync(join(RAW_MEDIA, "desk"), { recursive: true });
  const browser = await launchBrowser();
  try {
    // The shape of the space on the end card, so it's shown at about its real size and stays readable.
    const page = await browser.newPage({ viewport: { width: 1280, height: 460 } });
    for (const tab of DESK_TABS) {
      await page.goto(`${base}/#/${tab}`, { waitUntil: "networkidle", timeout: 30_000 });
      await page.locator("nav.tabs").waitFor({ timeout: 10_000 });
      if (await page.getByText("SYNTHETIC", { exact: false }).first().isVisible()) {
        process.stderr.write(`the Desk at ${base} is in fixture mode. Nothing saved for ${tab}\n`);
        return 1;
      }
      const path = join(RAW_MEDIA, deskShot(tab));
      await page.screenshot({ path });
      process.stdout.write(`wrote ${path}\n`);
    }
    return 0;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`video:desk failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
