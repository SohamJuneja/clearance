/**
 * Records each persona's Mattermost window, one browser context per persona.
 *
 * Frames come from Chrome's own screencast as JPEGs on disk and are encoded after the browser has
 * closed, so an encoder never competes with the scene for CPU or memory on a host that has run out of
 * both before. Screencast frames arrive only when the page changes; each frame's timestamp becomes its
 * display time, so the result stays true to the wall clock.
 *
 * Zoom: a 1536x864 CSS viewport at device scale 1.25 is exactly what browser zoom at 125% does on a
 * 1920x1080 window. A half-width window for split screens stays at 100%, which keeps Mattermost out of
 * its mobile layout, and its text is the same physical size once composed.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright-core";
import { REPO_ROOT, setting } from "../../eval/lib/paths.ts";
import { loadPersonaToken, type MattermostPost, Persona } from "../../eval/lib/persona.ts";
import type { PersonaWindow } from "../demo/person.ts";
import type { CaptureOutput, CaptureSession, PersonName, Recorder } from "../demo/runner.ts";

const execFileAsync = promisify(execFile);

export const OUTPUT = { width: 1920, height: 1080, fps: 30 } as const;
export type Layout = "full" | "half";

const LAYOUTS: Record<
  Layout,
  {
    viewport: { width: number; height: number };
    scale: number;
    frame: { width: number; height: number };
  }
> = {
  full: {
    viewport: { width: 1536, height: 864 },
    scale: 1.25,
    frame: { width: 1920, height: 1080 },
  },
  half: { viewport: { width: 960, height: 1080 }, scale: 1, frame: { width: 960, height: 1080 } },
};

export const RAW_MEDIA = join(REPO_ROOT, "docs/media/raw");

/** The browser to drive. `CLEARANCE_CHROMIUM` wins, then the snap, then Playwright's own if installed. */
export function chromiumPath(): string | undefined {
  const configured = setting("CLEARANCE_CHROMIUM");
  if (configured) return configured;
  return existsSync("/snap/bin/chromium") ? "/snap/bin/chromium" : undefined;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    timeout: 60_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
  });
}

/** Puts a name in the corner of every page in a context, drawn by the page so it survives navigation. */
function labelScript(label: string): string {
  return `(() => {
  try { localStorage.setItem("__landingPageSeen__", "true"); } catch {}
  const draw = () => {
    if (document.getElementById("clearance-persona-label")) return;
    const el = document.createElement("div");
    el.id = "clearance-persona-label";
    el.textContent = ${JSON.stringify(label)};
    el.style.cssText = "position:fixed;top:6px;left:8px;z-index:2147483647;padding:3px 14px;border-radius:6px;" +
      "background:#f5b301;color:#111;font:700 20px/26px system-ui,sans-serif;pointer-events:none;";
    document.documentElement.appendChild(el);
  };
  if (document.documentElement) draw();
  document.addEventListener("DOMContentLoaded", draw);
  // Mattermost's banners (preview mode, notification permission) arrive late and one at a time, cover
  // the top of the window, and say nothing about the demo.
  setInterval(() => {
    draw();
    const close = document.querySelector("a.announcement-bar__close");
    if (close) close.click();
  }, 250);
})();`;
}

export interface WindowOptions {
  browser: Browser;
  baseUrl: string;
  label: string;
  layout: Layout;
  /**
   * A personal access token and whose it is, used as the session. The web client decides it's signed in
   * from MMUSERID and authenticates with MMAUTHTOKEN. Absent: an anonymous window.
   */
  session?: { token: string; userId: string };
}

/** One persona's window: a browser context with its own session, label and zoom. */
export class MattermostWindow implements PersonaWindow {
  private openChannelName: string | undefined;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly baseUrl: string,
    private readonly team: string,
  ) {}

  static async open(options: WindowOptions & { team?: string }): Promise<MattermostWindow> {
    const shape = LAYOUTS[options.layout];
    const context = await options.browser.newContext({
      viewport: shape.viewport,
      deviceScaleFactor: shape.scale,
    });
    if (options.session) {
      await context.addCookies([
        {
          name: "MMAUTHTOKEN",
          value: options.session.token,
          url: options.baseUrl,
          httpOnly: true,
          sameSite: "Lax",
        },
        { name: "MMUSERID", value: options.session.userId, url: options.baseUrl, sameSite: "Lax" },
      ]);
    }
    await context.addInitScript({ content: labelScript(options.label) });
    const page = await context.newPage();
    return new MattermostWindow(
      context,
      page,
      options.baseUrl.replace(/\/$/, ""),
      options.team ?? "switch",
    );
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(`${this.baseUrl}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  }

  /** Opens a channel. A click on the sidebar when it's there, since that's what a person does. */
  async openChannel(channelName: string): Promise<void> {
    if (this.openChannelName === channelName) return;
    const link = this.page.locator(`#sidebarItem_${cssEscapeId(channelName)}`);
    // The sidebar's "More unreads" pill can sit over the link, and a direct visit always works.
    const clicked =
      (await link.count()) > 0 &&
      (await link
        .first()
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false));
    if (!clicked) await this.goto(`/${this.team}/channels/${channelName}`);
    await this.page.locator("#post_textbox").waitFor({ state: "visible", timeout: 30_000 });
    this.openChannelName = channelName;
  }

  async postInOpenChannel(message: string): Promise<void> {
    await this.typeAndSend("#post_textbox", message);
  }

  async replyInThread(post: MattermostPost, message: string): Promise<void> {
    const rootId = post.root_id || post.id;
    const row = this.page.locator(`#post_${rootId}`);
    await row.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await row.hover({ timeout: 5_000 });
    await this.page.locator(`#CENTER_commentIcon_${rootId}`).click({ timeout: 5_000 });
    await this.typeAndSend("#reply_textbox", message);
  }

  async clickButton(post: MattermostPost, button: string | RegExp): Promise<void> {
    const row = this.page.locator(`#post_${post.id}`);
    await row.scrollIntoViewIfNeeded({ timeout: 10_000 });
    await row.getByRole("button", { name: button }).first().click({ timeout: 5_000 });
  }

  /** Types the way a person does. The pause lets the mention list close, or Enter would pick from it. */
  private async typeAndSend(box: string, message: string): Promise<void> {
    const input = this.page.locator(box);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.click();
    await input.pressSequentially(message, { delay: 22 });
    const suggestions = this.page.locator(".suggestion-list__content");
    if (await suggestions.isVisible().catch(() => false)) await input.press("Escape");
    await input.press("Enter");
  }
}

/** Mattermost's sidebar ids carry channel names, which can hold characters CSS ids can't. */
function cssEscapeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

export interface TimedFrame {
  file: string;
  /** Seconds, on the same clock as the start and stop times. */
  at: number;
}

/**
 * How long each frame was on screen. A frame shows until the next one arrives, the first also covers
 * the wait from the start of recording, and the last holds until recording stopped. So the durations add
 * up to the wall-clock length of the capture, however rarely the page changed.
 */
export function frameDurations(
  frames: TimedFrame[],
  startedS: number,
  stoppedS: number,
): { file: string; durationS: number }[] {
  const shown = frames.map((frame, index) => {
    const from = index === 0 ? Math.min(startedS, frame.at) : frame.at;
    const next = frames[index + 1];
    const until = next ? next.at : Math.max(stoppedS, frame.at + 1 / OUTPUT.fps);
    return { file: frame.file, durationS: Math.max(0, until - from) };
  });
  return shown.filter((item, index) => item.durationS > 0 || index === shown.length - 1);
}

/** A screencast of one page: frames to a temp directory now, encoded later. */
export class Screencast {
  private readonly frames: { file: string; at: number }[] = [];
  private session: CDPSession | undefined;
  private started = 0;
  private stopped = 0;
  private pending: Promise<unknown> = Promise.resolve();
  readonly frameDir: string;

  constructor(
    private readonly page: Page,
    private readonly layout: Layout,
    scratch: string,
    name: string,
  ) {
    this.frameDir = join(scratch, name);
    mkdirSync(this.frameDir, { recursive: true });
  }

  async start(): Promise<void> {
    const { frame } = LAYOUTS[this.layout];
    this.session = await this.page.context().newCDPSession(this.page);
    const session = this.session;
    // Chrome sends frames only when the page changes, so a persona who sits and waits would otherwise
    // have no picture until something happens. This is the picture of how things stand now.
    const opening = join(this.frameDir, "opening.jpg");
    await this.page.screenshot({ path: opening, type: "jpeg", quality: 92 });
    this.frames.push({ file: opening, at: Date.now() / 1000 });
    session.on("Page.screencastFrame", (event) => {
      const number = this.frames.length;
      const file = join(this.frameDir, `${String(number).padStart(7, "0")}.jpg`);
      const at = event.metadata.timestamp ?? Date.now() / 1000;
      this.frames.push({ file, at });
      writeFileSync(file, Buffer.from(event.data, "base64"));
      this.pending = this.pending.then(() =>
        session
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => undefined),
      );
    });
    this.started = Date.now() / 1000;
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 92,
      maxWidth: frame.width,
      maxHeight: frame.height,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<void> {
    this.stopped = Date.now() / 1000;
    await this.session?.send("Page.stopScreencast").catch(() => undefined);
    await this.pending;
    await this.session?.detach().catch(() => undefined);
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Writes an mp4 where every frame shows for as long as it did on screen. */
  async encode(output: string): Promise<void> {
    if (this.frames.length === 0)
      throw new Error(`no frames were captured for ${basename(output)}`);
    const { frame } = LAYOUTS[this.layout];
    const shown = frameDurations(this.frames, this.started, this.stopped);
    const last = shown.at(-1)?.file;
    const lines = shown.flatMap((item) => [
      `file '${item.file}'`,
      `duration ${item.durationS.toFixed(6)}`,
    ]);
    // The concat demuxer ignores the last entry's duration unless the file appears once more after it.
    lines.push(`file '${last}'`);
    const list = join(this.frameDir, "frames.txt");
    writeFileSync(list, `${lines.join("\n")}\n`);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vf",
        `scale=${frame.width}:${frame.height}:flags=lanczos,fps=${OUTPUT.fps},format=yuv420p`,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-movflags",
        "+faststart",
        output,
      ],
      { timeout: 600_000 },
    );
  }
}

/** A new numbered directory for a scenario's next take. */
export function nextTakeDirectory(
  scenarioId: string,
  root: string = join(RAW_MEDIA, "takes"),
): string {
  const scenarioDir = join(root, scenarioId);
  mkdirSync(scenarioDir, { recursive: true });
  const taken = readdirSync(scenarioDir)
    .map(Number)
    .filter((value) => Number.isInteger(value));
  const number = (taken.length ? Math.max(...taken) : 0) + 1;
  const directory = join(scenarioDir, String(number));
  mkdirSync(directory);
  return directory;
}

/**
 * Points the scenario's `latest` at a take. Only done for a take that passed, so a build that names
 * `latest` can't pick up a scene that failed halfway.
 */
export function pointLatest(takeDirectory: string): void {
  const latest = join(dirname(takeDirectory), "latest");
  rmSync(latest, { force: true, recursive: true });
  symlinkSync(basename(takeDirectory), latest);
}

function displayName(persona: string): string {
  return `${persona[0]!.toUpperCase()}${persona.slice(1)}`;
}

/** What `pnpm demo:run --record` uses. One browser, one context per persona, closed the moment a scene ends. */
export function createRecorder(options: { root?: string } = {}): Recorder {
  return {
    async begin(spec): Promise<CaptureSession> {
      const directory = nextTakeDirectory(spec.scenarioId, options.root);
      const scratch = mkdtempSync(join(tmpdir(), `capture-${spec.scenarioId}-`));
      const browser = await launchBrowser();
      const windows = new Map<PersonName, MattermostWindow>();
      const casts = new Map<PersonName, Screencast>();
      const marks: { label: string; t: number }[] = [];
      let startedAt = 0;
      try {
        for (const persona of spec.personas) {
          const token = loadPersonaToken(persona);
          const api = new Persona({ name: persona, baseUrl: spec.baseUrl, token: () => token });
          const [team, me] = await Promise.all([api.team(), api.me()]);
          const window = await MattermostWindow.open({
            browser,
            baseUrl: spec.baseUrl,
            label: displayName(persona),
            layout: spec.layout,
            session: { token, userId: me.id },
            team: team.name,
          });
          await window.goto(`/${team.name}/channels/town-square`);
          await window.page.locator("#post_textbox").waitFor({ state: "visible", timeout: 45_000 });
          windows.set(persona, window);
          casts.set(persona, new Screencast(window.page, spec.layout, scratch, persona));
        }
        startedAt = Date.now();
        for (const cast of casts.values()) await cast.start();
      } catch (error) {
        await browser.close().catch(() => undefined);
        rmSync(scratch, { recursive: true, force: true });
        throw error;
      }
      return {
        window: (persona) => windows.get(persona),
        mark: (label) => marks.push({ label, t: (Date.now() - startedAt) / 1000 }),
        async end(passed: boolean): Promise<CaptureOutput> {
          for (const cast of casts.values()) await cast.stop();
          await browser.close().catch(() => undefined);
          const files: Record<string, string> = {};
          try {
            for (const [persona, cast] of casts) {
              const file = join(directory, `${persona}.mp4`);
              await cast.encode(file);
              files[persona] = file;
            }
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
          writeFileSync(join(directory, "marks.json"), `${JSON.stringify(marks, null, 2)}\n`);
          if (passed) pointLatest(directory);
          return { directory, files };
        },
      };
    },
  };
}
