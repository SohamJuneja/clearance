// The whole film is data: film.json at the project root. Scenes are typed below.
// Times are seconds in film.json; components convert with fps.
import filmJson from "../film.json";

export type Transition =
  | { type: "cut" }
  | { type: "fade" | "zoom" | "blur" | "tear"; dur?: number }
  | { type: "slide" | "wipe"; dur?: number; dir?: "from-left" | "from-right" | "from-top" | "from-bottom" };

export type Overlay =
  | { kind: "lottie"; src: string; at: number; dur: number; x?: number; y?: number; w?: number; loop?: boolean }
  | { kind: "gif"; src: string; at: number; dur: number; x?: number; y?: number; w?: number; h?: number }
  | { kind: "image"; src: string; at: number; dur: number; x?: number; y?: number; w?: number }
  | { kind: "label"; text: string; at: number; dur: number; x: number; y: number; tone?: "accent" | "good" | "bad" | "plain" }
  | { kind: "arrow"; at: number; dur: number; from: [number, number]; to: [number, number] }
  | { kind: "face"; src: string; at: number; dur: number; x?: number; y?: number; w?: number }
  | { kind: "stamp"; text: string; sub?: string; at: number; dur: number; x: number; y: number; w?: number; rot?: number;
      color?: "red" | "violet" | "green"; shape?: "rect" | "oval" };

type Base = { id: string; duration: number; transition?: Transition; overlays?: Overlay[]; backdrop?: boolean; drift?: boolean;
  riserInto?: boolean; sfx?: { at: number; sfx: string; db?: number; align?: string }[]; min?: number };

export type Scene = Base &
  (
    | { type: "kinetic"; lines: string[]; emphasis?: string[]; kicker?: string; align?: "center" | "left" }
    | { type: "phonestep"; src: string; step?: string; title: string; body?: string; side?: "left" | "right" }
    | ({ type: "footage" } & Omit<import("./scenes/Footage").FootageProps, "dur">)
    | { type: "screen"; src: string; events?: string; meta?: string; note?: string; trimBefore?: number; playbackRate?: number;
        zooms?: { at: number; dur?: number; box: { x: number; y: number; w: number; h: number }; scale?: number }[];
        callouts?: { at: number; dur?: number; text: string; x: number; y: number }[];
        title?: string; chrome?: boolean; url?: string }
    | { type: "device3d"; src: string; device?: "laptop" | "phone"; title?: string; flatten?: boolean } // trim the clip with ffmpeg first
    | { type: "hero3d"; title?: string; subtitle?: string; model?: string; modelScale?: number; clip?: string; shape?: "orbits" | "grid" | "monolith" }
    | { type: "persona"; name: string; role: string; quote?: string; stakes: string; stat?: { value: string; label: string }; photo?: string }
    | { type: "diagram"; title?: string;
        nodes: { id: string; label: string; sub?: string; x: number; y: number; hero?: boolean; icon?: string }[];
        edges: { from: string; to: string; label?: string }[] ; order?: string[] }
    | { type: "proof"; title: string; metric: string; unit?: string; better: "higher" | "lower";
        rows: { label: string; value: number; ours?: boolean; note?: string }[]; footnote?: string }
    | { type: "code"; title?: string; file?: string; lang?: string; code: string; highlight?: number[][] }
    | ({ type: "arch3d" } & Omit<import("./scenes/Arch3D").Arch3DProps, "dur">)
    | { type: "endcard"; name: string; tagline: string; links: string[]; logo?: string }
    | ({ type: "stampcard" } & Omit<import("./scenes/Paper").StampCardProps, "dur">)
    | ({ type: "facts" } & Omit<import("./scenes/Paper").FactsProps, "dur">)
    | ({ type: "docket" } & Omit<import("./scenes/Paper").DocketProps, "dur">)
    | ({ type: "room" } & Omit<import("./scenes/Paper").RoomProps, "dur">)
    | ({ type: "ledgerproof" } & Omit<import("./scenes/Paper").LedgerProofProps, "dur">)
    | ({ type: "bigfigures" } & Omit<import("./scenes/Paper").BigFiguresProps, "dur">)
  );

export type Film = {
  title: string;
  fps: number;
  width: number;
  height: number;
  theme: { bg: string; surface: string; fg: string; muted: string; accent: string; accent2: string; good: string; bad: string;
           display: string; mono: string };
  previewAudio?: string;   // master.wav for Studio preview; final mux happens in mix.py
  thumbBg?: string;        // frame grab for the thumbnail
  captions?: string;       // captions.json (Caption[]) burned in when set
  scenes: Scene[];
};

export const film = filmJson as unknown as Film;
export const sec = (s: number) => Math.round(s * film.fps);
