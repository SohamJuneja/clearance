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
  paper: "#F4F6FF", paperDeep: "#E6ECFF", rule: "#A9BEF2", margin: "#FF8FA3",
  white: "#FFFFFF", canary: "#FFDD55", pink: "#FFB0C8",
  ink: "#14172B", inkSoft: "#3B4266", inkFaint: "#666E95",
  red: "#E8243F", violet: "#5B3DF5", green: "#13A15A",
};
