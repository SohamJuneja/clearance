import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIP_LIMIT_S, clipBoard, CLIPS } from "./social.ts";
import { loadStoryboard } from "./scenes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const board = loadStoryboard(join(here, "scenes.yaml"));
const clip = (name: string) => {
  const found = CLIPS.find((one) => one.name === name);
  if (!found) throw new Error(`no clip ${name}`);
  return clipBoard(board, found.scenes);
};

describe("the #HowISwitch clips", () => {
  it("post 1 is SC2 then SC3, and post 2 is SC9, as docs/build/social-draft.md says", () => {
    expect(clip("post-1").scenes.map((scene) => scene.id)).toEqual(["sc2", "sc3-refused", "sc3-sam"]);
    expect(clip("post-2").scenes.map((scene) => scene.id)).toEqual(["sc9"]);
  });

  it("plans each under the posts' limit, which the build then holds it to", () => {
    for (const { name } of CLIPS) {
      const planned = clip(name).scenes.reduce((sum, scene) => sum + scene.planned_s, 0);
      expect(planned, name).toBeLessThan(CLIP_LIMIT_S);
      expect(clip(name).max_duration_s, name).toBe(CLIP_LIMIT_S);
    }
  });

  it("keeps 'persona actions are scripted' on both", () => {
    for (const { name } of CLIPS) {
      expect(clip(name).default_notices.join(" "), name).toContain("persona actions are scripted");
    }
  });

  it("keeps both of the drill scene's labels on post 2, and the scene's own wording everywhere", () => {
    const labels = clip("post-2").scenes[0]?.timed_callouts?.map((callout) => callout.text).join(" ");
    expect(labels).toContain("planted flaw");
    expect(labels).toContain("The next card is real");
    expect(clip("post-1").scenes[1]).toEqual(board.scenes.find((scene) => scene.id === "sc3-refused"));
  });

  it("still holds post 1's refusal to its time, and post 2 has no refusal to check", () => {
    expect(clip("post-1").first_refusal).toEqual(board.first_refusal);
    expect(clip("post-2").first_refusal).toBeUndefined();
  });

  it("fails on a scene that doesn't exist, rather than a shorter clip", () => {
    expect(() => clipBoard(board, ["sc2", "nope"])).toThrow(/no scene nope/);
  });
});
