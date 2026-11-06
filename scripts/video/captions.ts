/**
 * Burned-in text, as one ASS subtitle file per scene. libass draws it, so a rupee sign and wrapped lines
 * come out right; line breaks are ours, so nothing depends on how a font happens to measure.
 *
 * The frame has fixed zones (see FRAME in compose.ts): footage on top, a caption band below, so a caption
 * can never sit over the message box a persona is typing in. Callouts share one row across the top, over Mattermost's
 * own header bar, so they can't sit on a post either.
 */
export const CAPTION_FONT = "Noto Sans";
export const MAX_CHARS_PER_LINE = 78;
export const MAX_LINES_PER_CUE = 2;

export interface Cue {
  startS: number;
  endS: number;
  lines: string[];
}

/** Breaks text into lines at spaces. A single word longer than a line gets a line of its own. */
export function wrapText(text: string, maxChars: number = MAX_CHARS_PER_LINE): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Sentences first, then at most two lines at a time, so a caption doesn't end mid-thought if it can help it. */
export function captionChunks(
  text: string,
  maxChars: number = MAX_CHARS_PER_LINE,
  maxLines: number = MAX_LINES_PER_CUE,
): string[][] {
  const chunks: string[][] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const lines = wrapText(sentence, maxChars);
    for (let i = 0; i < lines.length; i += maxLines) chunks.push(lines.slice(i, i + maxLines));
  }
  return chunks;
}

/**
 * Times captions across the speech, each for a share of `durationS` matching its share of the characters.
 * Good enough to read along with; it's not lip sync.
 */
export function timeCues(chunks: string[][], startS: number, durationS: number): Cue[] {
  const lengths = chunks.map((lines) => lines.join(" ").length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return [];
  const cues: Cue[] = [];
  let at = startS;
  chunks.forEach((lines, index) => {
    const share = (durationS * (lengths[index] as number)) / total;
    cues.push({ startS: at, endS: at + share, lines });
    at += share;
  });
  return cues;
}

export function assTime(seconds: number): string {
  const centis = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(centis / 360000);
  const m = Math.floor(centis / 6000) % 60;
  const s = Math.floor(centis / 100) % 60;
  const cs = centis % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

export interface SceneText {
  durationS: number;
  /** The voice-over, shown in the caption band while it's spoken. */
  cues: Cue[];
  /** Small standing notes at the foot of the frame, such as "persona actions are scripted". */
  notices: string[];
  /** Prominent standing labels above the posts, such as "staged illustration, real clicks". They share one row. */
  callouts: string[];
  /** The same labels, for part of the scene. In the same place, so they shouldn't overlap each other or `callouts`. */
  timedCallouts?: { text: string; startS: number; endS: number }[];
  /** Words for the corner label, such as "clock 10x". */
  corner: string[];
}

const COLOUR = {
  white: "&H00FFFFFF",
  dim: "&H00C8CDD6",
  black: "&H00000000",
  amber: "&H0001B3F5",
  ink: "&H00111111",
};

interface AssStyle {
  name: string;
  size: number;
  colour: string;
  /** With `boxed`, libass paints the box in the outline colour. */
  boxed?: string;
  bold?: boolean;
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
}

function assStyle(style: AssStyle): string {
  const fields = [
    style.name,
    CAPTION_FONT,
    style.size,
    style.colour,
    style.colour,
    style.boxed ?? COLOUR.black,
    COLOUR.black,
    style.bold ? 1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    style.boxed ? 3 : 1,
    style.boxed ? 10 : 0,
    0,
    style.alignment,
    style.marginL,
    style.marginR,
    style.marginV,
    1,
  ];
  return `Style: ${fields.join(",")}`;
}

/**
 * Numpad alignments: 2 is bottom centre, 8 top centre, 9 top right. Margins follow FRAME in compose.ts.
 * An ASS size is the font's full line height, so a size of 52 in Noto Sans is about 38 px of em. Two
 * lines of Narration fill y 930 to 1034, and the footage ends at 914.
 */
const STYLES: AssStyle[] = [
  {
    name: "Narration",
    size: 52,
    colour: COLOUR.white,
    alignment: 2,
    marginL: 60,
    marginR: 60,
    marginV: 46,
  },
  {
    name: "Notice",
    size: 30,
    colour: COLOUR.dim,
    alignment: 2,
    marginL: 60,
    marginR: 60,
    marginV: 8,
  },
  {
    name: "Callout",
    size: 34,
    colour: COLOUR.ink,
    boxed: COLOUR.amber,
    bold: true,
    alignment: 8,
    marginL: 200,
    marginR: 200,
    marginV: 30,
  },
  {
    name: "Corner",
    size: 32,
    colour: COLOUR.ink,
    boxed: COLOUR.amber,
    bold: true,
    alignment: 9,
    marginL: 60,
    marginR: 182,
    marginV: 30,
  },
];

/** Past this a callout row would reach the corner label at full size. At size 30 a hundred characters still clear it. */
const CALLOUT_FULL_SIZE_CHARS = 80;
/** Keeps the box on Mattermost's header bar, which ends about 64 px down in either layout. */
const CALLOUT_MARGIN_V = 24;

export function assDocument(scene: SceneText): string {
  const out = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...STYLES.map(assStyle),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const whole = `${assTime(0)},${assTime(scene.durationS)}`;
  for (const cue of scene.cues) {
    const text = cue.lines.map(assText).join("\\N");
    out.push(`Dialogue: 1,${assTime(cue.startS)},${assTime(cue.endS)},Narration,,0,0,0,,${text}`);
  }
  if (scene.notices.length > 0) {
    out.push(`Dialogue: 1,${whole},Notice,,0,0,0,,${assText(scene.notices.join("  ·  "))}`);
  }
  if (scene.callouts.length > 0) {
    const row = scene.callouts.join("  ·  ");
    const fit = row.length > CALLOUT_FULL_SIZE_CHARS ? "{\\fs30}" : "";
    out.push(`Dialogue: 2,${whole},Callout,,0,0,${CALLOUT_MARGIN_V},,${fit}${assText(row)}`);
  }
  for (const { text, startS, endS } of scene.timedCallouts ?? []) {
    const fit = text.length > CALLOUT_FULL_SIZE_CHARS ? "{\\fs30}" : "";
    out.push(
      `Dialogue: 2,${assTime(startS)},${assTime(endS)},Callout,,0,0,${CALLOUT_MARGIN_V},,${fit}${assText(text)}`,
    );
  }
  scene.corner.forEach((corner, index) => {
    out.push(`Dialogue: 2,${whole},Corner,,0,0,${30 + index * 68},,${assText(corner)}`);
  });
  return `${out.join("\n")}\n`;
}
