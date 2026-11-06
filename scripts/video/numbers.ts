/**
 * Every number in the video comes from RESULTS.md or a source the storyboard declares. This reads what the script itself
 * says, with the `{{...}}` placeholders taken out, and names anything numeric that's left. The build fails on any of it,
 * so a number can't be typed into a voice-over, a caption or a card and quietly reach the video.
 *
 * Number words count too, or "ninety-three percent" would walk straight past. "One" doesn't: "one inbox" and "one
 * incident" aren't measurements, and any list that flagged them would soon be ignored.
 */
import { scriptedWords } from "./results.ts";
import type { Scene, Storyboard } from "./scenes.ts";

const NUMBER_WORDS =
  "zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent";
const NUMERIC = new RegExp(`\\S*\\d\\S*|\\b(?:${NUMBER_WORDS})\\b`, "gi");

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Everything a scene says or shows in words. Footage is what it is, and a RESULTS.md row is RESULTS.md. */
function wordsOf(scene: Scene, board: Storyboard): string[] {
  const footage = scene.kind === "clip" || scene.kind === "split";
  return [
    scene.voiceover,
    scene.kind === "card" || scene.kind === "numbers" ? scene.headline : undefined,
    ...(scene.kind === "card" ? (scene.lines ?? []) : []),
    ...(scene.callouts ?? []),
    ...(scene.notices ?? []),
    ...(footage ? board.default_notices : []),
  ].filter((text): text is string => text !== undefined);
}

/** Each number with no source, as `scene: "number" in "the text"`. Empty means the board is clean. */
export function unsourcedNumbers(board: Storyboard): string[] {
  const problems: string[] = [];
  for (const scene of board.scenes) {
    const allowed = board.cited
      .filter((one) => !one.only_in || one.only_in.includes(scene.id))
      .map((one) => one.value)
      // Longest first, so "₹40,000" goes before anything inside it.
      .sort((a, b) => b.length - a.length);
    for (const text of wordsOf(scene, board)) {
      let left = scriptedWords(text);
      for (const value of allowed) {
        left = left.replace(new RegExp(escapeRegex(value), "gi"), " ");
      }
      for (const found of left.match(NUMERIC) ?? []) {
        problems.push(`${scene.id}: "${found}" in "${text.slice(0, 70)}"`);
      }
    }
  }
  return problems;
}

export function ensureSourcedNumbers(board: Storyboard): void {
  const problems = unsourcedNumbers(board);
  if (problems.length === 0) return;
  throw new Error(
    `these numbers have no source. Pull them from RESULTS.md with {{...}}, or declare where they come from under \`cited\`:\n${problems
      .map((problem) => `  ${problem}`)
      .join("\n")}`,
  );
}
