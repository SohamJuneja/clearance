import { loadFont as archivo } from "@remotion/google-fonts/Archivo";
import { loadFont as plex } from "@remotion/google-fonts/IBMPlexMono";
import { film } from "./film";

// The project's own faces (the site uses the same): Archivo for type with weight, IBM Plex Mono for ids, hashes and labels.
const display = archivo("normal", { weights: ["400", "500", "600", "700", "800", "900"], subsets: ["latin", "latin-ext"] });
const code = plex("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });

export const T = {
  ...film.theme,
  font: display.fontFamily,
  monoFont: code.fontFamily,
  // type scale at 1080p (readable after YouTube compression on a laptop)
  h1: 112, h2: 76, h3: 52, body: 40, small: 30, label: 26,
  safeX: 96, safeY: 84,
  // the paperwork world: ledger stock, carbon copies, stamp inks
  paper: "#ECEEE7", paperDeep: "#E1E5DC", rule: "#B9C8D6", margin: "#D79292",
  white: "#FBFBF7", canary: "#F6E58F", pink: "#F3C8D2",
  ink: "#1B1E23", inkSoft: "#484E57", inkFaint: "#6E747C",
  red: "#C2283A", violet: "#4232A4", green: "#2E6B45",
};
